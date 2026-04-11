#!/usr/bin/env python3
"""
Headless camera capture for Seashell Desk.

Captures a photo from an Arducam USB camera, applies optional perspective
correction and post-processing, and writes the result to a specified path.
Outputs a JSON summary to stdout for the TypeScript caller.

Based on desk-m2/document_scanner.py.
"""

import cv2
import numpy as np
import argparse
import json
import os
import sys
import time
from pathlib import Path

# Arducam 16MP IMX298 capture modes
HIGH_MODE = ("MJPG", 10, 4656, 3496)
MID_MODE  = ("MJPG", 10, 3264, 2448)
LOW_MODE  = ("MJPG", 30, 1920, 1080)

CONFIG_FILE = Path(__file__).parent / "camera_config.json"


def load_config():
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def setup_camera(camera_index, mode):
    codec, fps, width, height = mode
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera {camera_index}")

    # Start in 1080p to let autofocus and auto-exposure stabilise, then
    # switch to the requested resolution for capture.  Image-tuning props
    # (brightness, contrast, etc.) break capture above 1080p on macOS
    # AVFoundation, so they are only applied during the warmup phase.
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    cap.set(cv2.CAP_PROP_FPS, 30)
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 3)
    cap.set(cv2.CAP_PROP_AUTO_WB, 1)
    cap.set(cv2.CAP_PROP_BRIGHTNESS, 0.8)
    cap.set(cv2.CAP_PROP_CONTRAST, 0.6)
    cap.set(cv2.CAP_PROP_SATURATION, 0.4)
    cap.set(cv2.CAP_PROP_GAIN, 0.3)

    # Apply saved focus or let autofocus run
    config = load_config()
    if "optimal_focus" in config:
        cap.set(cv2.CAP_PROP_AUTOFOCUS, 0)
        cap.set(cv2.CAP_PROP_FOCUS, config["optimal_focus"])

    # Warm up at 1080p — flush frames to let focus and exposure converge
    print("Warming up at 1080p...", file=sys.stderr)
    time.sleep(3)
    for _ in range(20):
        cap.read()
        time.sleep(0.1)

    # Now switch to the target resolution if it differs
    if width != 1920 or height != 1080:
        # Release and re-open to cleanly switch modes
        cap.release()
        cap = cv2.VideoCapture(camera_index)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot reopen camera {camera_index}")
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter.fourcc(*codec))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        cap.set(cv2.CAP_PROP_FPS, fps)
        time.sleep(10)

    actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"Camera ready: {actual_w}x{actual_h} @ {fps}fps ({codec})", file=sys.stderr)
    return cap


def capture_stacked(cap, num_frames):
    """Capture multiple frames and average for noise reduction."""
    fps = cap.get(cv2.CAP_PROP_FPS)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    high_res = w > 1920
    delay = 0.5 if high_res else (0.3 if fps <= 10 else 0.1)

    # Flush stale frames from the buffer.
    # At high-res, reads may fail for the first several attempts while the
    # sensor spins up — keep trying until we get at least one good frame.
    flush_target = 5 if high_res else 10
    flush_ok = 0
    for _ in range(30 if high_res else flush_target):
        ret, _ = cap.read()
        if ret:
            flush_ok += 1
        time.sleep(delay)
        if flush_ok >= flush_target:
            break

    frames = []
    for i in range(num_frames):
        ret, frame = cap.read()
        if ret and frame is not None and frame.size > 0:
            frames.append(frame.astype(np.float32))
        time.sleep(delay)

    if not frames:
        raise RuntimeError("Failed to capture any frames")

    stacked = np.zeros_like(frames[0])
    for f in frames:
        stacked += f
    return (stacked / len(frames)).astype(np.uint8)


def order_corners(corners):
    """Order corners: top-left, top-right, bottom-right, bottom-left."""
    corners = corners.reshape(4, 2)
    s = corners.sum(axis=1)
    diff = corners[:, 0] - corners[:, 1]
    return np.array([
        corners[np.argmin(s)],      # top-left
        corners[np.argmin(diff)],   # top-right
        corners[np.argmax(s)],      # bottom-right
        corners[np.argmax(diff)],   # bottom-left
    ], dtype=np.float32)


def transform_document(image, corners, output_size=2000, enhance=True):
    """Apply perspective correction and optional document enhancement."""
    ordered = order_corners(np.array(corners, dtype=np.float32))
    tl, tr, br, bl = ordered

    top_w = float(np.linalg.norm(tr - tl))
    bot_w = float(np.linalg.norm(br - bl))
    left_h = float(np.linalg.norm(bl - tl))
    right_h = float(np.linalg.norm(br - tr))
    avg_w = int((top_w + bot_w) / 2)
    avg_h = int((left_h + right_h) / 2)

    # Scale to fit within output_size
    max_dim = max(avg_w, avg_h)
    if max_dim > output_size:
        scale = output_size / max_dim
        out_w, out_h = int(avg_w * scale), int(avg_h * scale)
    else:
        out_w, out_h = avg_w, avg_h

    dst = np.array([
        [0, 0], [out_w - 1, 0],
        [out_w - 1, out_h - 1], [0, out_h - 1],
    ], dtype=np.float32)

    M = cv2.getPerspectiveTransform(ordered, dst)
    warped = cv2.warpPerspective(image, M, (out_w, out_h))

    if not enhance:
        return warped

    # Flip (camera is upside-down in the mount) + contrast stretch
    flipped = cv2.flip(warped, 0)
    enhanced = flipped.copy()
    for ch in range(3):
        data = enhanced[:, :, ch]
        lo = np.percentile(data, 1)
        hi = np.percentile(data, 99)
        if hi - lo > 0:
            enhanced[:, :, ch] = np.clip(
                (data - lo) * 255.0 / (hi - lo), 0, 255
            ).astype(np.uint8)
    return enhanced


def post_process(image, max_dimension, grayscale=True, auto_levels=True):
    """Grayscale conversion + resize + optional contrast stretch."""
    if grayscale:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Auto-levels: stretch histogram for maximum contrast
    if auto_levels:
        if len(image.shape) == 2:
            lo = np.percentile(image, 1)
            hi = np.percentile(image, 99)
            if hi - lo > 0:
                image = np.clip((image.astype(np.float32) - lo) * 255.0 / (hi - lo), 0, 255).astype(np.uint8)
        else:
            for ch in range(image.shape[2]):
                data = image[:, :, ch]
                lo = np.percentile(data, 1)
                hi = np.percentile(data, 99)
                if hi - lo > 0:
                    image[:, :, ch] = np.clip(
                        (data.astype(np.float32) - lo) * 255.0 / (hi - lo), 0, 255
                    ).astype(np.uint8)

    h, w = image.shape[:2]
    if max(h, w) > max_dimension:
        if w > h:
            new_w, new_h = max_dimension, int(h * max_dimension / w)
        else:
            new_h, new_w = max_dimension, int(w * max_dimension / h)
        image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)

    return image


def main():
    parser = argparse.ArgumentParser(description="Seashell Desk camera capture")
    parser.add_argument("--output", "-o", required=True, help="Output JPEG path")
    parser.add_argument("--camera", type=int, default=0, help="Camera index (default: 0)")
    parser.add_argument("--stack", type=int, default=3, help="Frames to stack (default: 3)")
    parser.add_argument("--max-dimension", type=int, default=2000, help="Max output dimension (default: 2000)")
    parser.add_argument("--jpeg-quality", type=int, default=90, help="JPEG quality 1-100 (default: 90)")
    parser.add_argument("--use-bounds", action="store_true", help="Apply saved perspective correction")
    parser.add_argument("--no-enhance", action="store_true", help="Skip document enhancement")
    parser.add_argument("--no-grayscale", action="store_true", help="Keep color output")
    parser.add_argument("--high", action="store_true", help="Use high-res mode (4656x3496)")
    parser.add_argument("--mid", action="store_true", help="Use mid-res mode (3264x2448)")
    parser.add_argument("--crop", type=str, default=None,
                        help="Crop region as x,y,w,h in percent of frame (e.g. 20,10,40,50)")
    parser.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270],
                        help="Rotate image clockwise by degrees (0, 90, 180, 270)")
    args = parser.parse_args()

    mode = HIGH_MODE if args.high else MID_MODE if args.mid else LOW_MODE

    cap = None
    try:
        cap = setup_camera(args.camera, mode)
        print(f"Capturing {args.stack} frames...", file=sys.stderr)
        frame = capture_stacked(cap, args.stack)

        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # Apply crop if specified (percentages of frame)
        if args.crop:
            cx, cy, cw, ch = [float(v) for v in args.crop.split(",")]
            fh, fw = frame.shape[:2]
            x1 = int(fw * cx / 100)
            y1 = int(fh * cy / 100)
            x2 = int(fw * (cx + cw) / 100)
            y2 = int(fh * (cy + ch) / 100)
            frame = frame[y1:y2, x1:x2]
            print(f"Cropped to {frame.shape[1]}x{frame.shape[0]}", file=sys.stderr)

        # Rotate if requested
        if args.rotate == 90:
            frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
        elif args.rotate == 180:
            frame = cv2.rotate(frame, cv2.ROTATE_180)
        elif args.rotate == 270:
            frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)

        # Apply perspective correction if requested and bounds exist
        transformed = False
        if args.use_bounds:
            config = load_config()
            bounds = config.get("saved_bounds")
            if bounds and bounds.get("corners"):
                print("Applying perspective correction...", file=sys.stderr)
                frame = transform_document(
                    frame, bounds["corners"],
                    output_size=args.max_dimension,
                    enhance=not args.no_enhance,
                )
                transformed = True

        # Post-process
        result = post_process(
            frame,
            max_dimension=args.max_dimension,
            grayscale=not args.no_grayscale,
        )

        # Write output
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        cv2.imwrite(args.output, result, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])

        h, w = result.shape[:2]
        size_bytes = os.path.getsize(args.output)

        # JSON result to stdout
        json.dump({
            "path": args.output,
            "width": w,
            "height": h,
            "size_bytes": size_bytes,
            "capture_resolution": f"{actual_w}x{actual_h}",
            "stacked_frames": args.stack,
            "transformed": transformed,
            "grayscale": not args.no_grayscale,
        }, sys.stdout)
        print(file=sys.stderr)
        print(f"Saved: {args.output} ({w}x{h}, {size_bytes // 1024} KB)", file=sys.stderr)

    except Exception as e:
        json.dump({"error": str(e)}, sys.stdout)
        sys.exit(1)
    finally:
        if cap is not None:
            cap.release()


if __name__ == "__main__":
    main()
