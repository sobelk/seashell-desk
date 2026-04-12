#!/usr/bin/env python3
"""
Headless camera capture and document-scanner utilities for Seashell Desk.

Supports:
- direct capture from the mounted desk camera
- document quad detection from an input image
- perspective correction and scan enhancement from an input image
- saving calibrated scan bounds for a fixed camera setup
"""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

# Arducam 16MP IMX298 capture modes
HIGH_MODE = ("MJPG", 10, 4656, 3496)
MID_MODE = ("MJPG", 10, 3264, 2448)
LOW_MODE = ("MJPG", 30, 1920, 1080)

CONFIG_FILE = Path(__file__).parent / "camera_config.json"
DETECT_MAX_DIMENSION = 1600


def log(message):
    print(message, file=sys.stderr)


def load_config():
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text())
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def save_config(config):
    CONFIG_FILE.write_text(json.dumps(config, indent=2) + "\n")


def setup_camera(camera_index, mode):
    codec, fps, width, height = mode
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open camera {camera_index}")

    # Warm up in 1080p so focus and exposure converge before switching modes.
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    cap.set(cv2.CAP_PROP_FPS, 30)
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 3)
    cap.set(cv2.CAP_PROP_AUTO_WB, 1)
    cap.set(cv2.CAP_PROP_BRIGHTNESS, 0.8)
    cap.set(cv2.CAP_PROP_CONTRAST, 0.6)
    cap.set(cv2.CAP_PROP_SATURATION, 0.4)
    cap.set(cv2.CAP_PROP_GAIN, 0.3)

    config = load_config()
    if "optimal_focus" in config:
        cap.set(cv2.CAP_PROP_AUTOFOCUS, 0)
        cap.set(cv2.CAP_PROP_FOCUS, config["optimal_focus"])

    log("Warming up at 1080p...")
    time.sleep(3)
    for _ in range(20):
        cap.read()
        time.sleep(0.1)

    if width != 1920 or height != 1080:
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
    log(f"Camera ready: {actual_w}x{actual_h} @ {fps}fps ({codec})")
    return cap


def capture_stacked(cap, num_frames):
    fps = cap.get(cv2.CAP_PROP_FPS)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    high_res = w > 1920
    delay = 0.5 if high_res else (0.3 if fps <= 10 else 0.1)

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
    for _ in range(num_frames):
        ret, frame = cap.read()
        if ret and frame is not None and frame.size > 0:
            frames.append(frame.astype(np.float32))
        time.sleep(delay)

    if not frames:
        raise RuntimeError("Failed to capture any frames")

    stacked = np.zeros_like(frames[0])
    for frame in frames:
        stacked += frame
    return (stacked / len(frames)).astype(np.uint8)


def order_corners(corners):
    corners = np.array(corners, dtype=np.float32).reshape(4, 2)
    sums = corners.sum(axis=1)
    diffs = np.diff(corners, axis=1).reshape(4)
    return np.array([
        corners[np.argmin(sums)],   # top-left
        corners[np.argmin(diffs)],  # top-right
        corners[np.argmax(sums)],   # bottom-right
        corners[np.argmax(diffs)],  # bottom-left
    ], dtype=np.float32)


def compute_quad_metrics(corners):
    ordered = order_corners(corners)
    tl, tr, br, bl = ordered
    top_w = float(np.linalg.norm(tr - tl))
    bot_w = float(np.linalg.norm(br - bl))
    left_h = float(np.linalg.norm(bl - tl))
    right_h = float(np.linalg.norm(br - tr))
    avg_w = max(1.0, (top_w + bot_w) / 2.0)
    avg_h = max(1.0, (left_h + right_h) / 2.0)
    return ordered, avg_w, avg_h


def normalize_quad(corners, width, height):
    ordered = order_corners(corners)
    normalized = []
    for x, y in ordered:
        nx = max(0.0, min(1.0, float(x) / float(width)))
        ny = max(0.0, min(1.0, float(y) / float(height)))
        normalized.append([nx, ny])
    return normalized


def denormalize_quad(normalized_corners, width, height):
    points = []
    for x, y in normalized_corners:
        points.append([
            max(0.0, min(width - 1.0, float(x) * width)),
            max(0.0, min(height - 1.0, float(y) * height)),
        ])
    return order_corners(points)


def parse_quad_arg(value):
    points = []
    for pair in value.split(";"):
        x_str, y_str = pair.split(",")
        points.append([float(x_str), float(y_str)])
    if len(points) != 4:
        raise ValueError("Quad must contain exactly four points")
    return order_corners(points)


def angle_score(corners):
    ordered = order_corners(corners)
    score = 0.0
    for idx in range(4):
        prev_pt = ordered[(idx - 1) % 4]
        cur_pt = ordered[idx]
        next_pt = ordered[(idx + 1) % 4]
        a = prev_pt - cur_pt
        b = next_pt - cur_pt
        denom = np.linalg.norm(a) * np.linalg.norm(b)
        if denom <= 1e-5:
            return 0.0
        cosine = abs(float(np.dot(a, b) / denom))
        score += max(0.0, 1.0 - cosine)
    return score / 4.0


def quad_confidence(corners, image_shape):
    height, width = image_shape[:2]
    ordered, avg_w, avg_h = compute_quad_metrics(corners)
    area = float(cv2.contourArea(ordered))
    if area <= 0:
        return 0.0

    area_ratio = area / float(width * height)
    if area_ratio < 0.05:
        return 0.0

    center = ordered.mean(axis=0)
    image_center = np.array([width / 2.0, height / 2.0], dtype=np.float32)
    distance = float(np.linalg.norm(center - image_center))
    center_score = max(0.0, 1.0 - distance / math.hypot(width, height))

    rect_area = max(1.0, avg_w * avg_h)
    rectangularity = min(1.0, area / rect_area)
    geometry_score = angle_score(ordered)

    border_margin = min(
        ordered[:, 0].min(),
        ordered[:, 1].min(),
        width - ordered[:, 0].max(),
        height - ordered[:, 1].max(),
    )
    border_score = 1.0 if border_margin >= 8 else max(0.0, border_margin / 8.0)

    score = (
        min(1.0, area_ratio / 0.7) * 0.45 +
        geometry_score * 0.25 +
        rectangularity * 0.15 +
        center_score * 0.10 +
        border_score * 0.05
    )
    return max(0.0, min(1.0, score))


def resize_for_detection(image, max_dimension=DETECT_MAX_DIMENSION):
    height, width = image.shape[:2]
    scale = min(1.0, float(max_dimension) / float(max(height, width)))
    if scale >= 1.0:
        return image.copy(), 1.0
    resized = cv2.resize(image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
    return resized, scale


def detect_document_quad_opencv(image):
    resized, scale = resize_for_detection(image)
    # Algorithm adapted from Scanbot's OpenCV edge-detection walkthrough:
    # https://scanbot.io/techblog/document-edge-detection-with-opencv/
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    edges = cv2.Canny(binary, 50, 150)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:5]

    doc_quad = None
    for contour in contours:
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        if len(approx) == 4:
            doc_quad = approx.reshape(4, 2)
            break

    if doc_quad is None:
        return None, 0.0, "none"

    confidence = quad_confidence(doc_quad, resized.shape)
    full_res = order_corners(doc_quad / scale)
    full_res[:, 0] = np.clip(full_res[:, 0], 0, image.shape[1] - 1)
    full_res[:, 1] = np.clip(full_res[:, 1], 0, image.shape[0] - 1)
    log(f"OpenCV detection selected source=contour_pipeline confidence={confidence:.3f}")
    return full_res, confidence, "opencv_contour_pipeline"


def load_saved_bounds_for_shape(width, height):
    config = load_config()
    bounds = config.get("saved_bounds") or {}
    source_dimensions = bounds.get("source_dimensions") or config.get("last_working_resolution")
    if source_dimensions and len(source_dimensions) == 2:
        src_w, src_h = float(source_dimensions[0]), float(source_dimensions[1])
        if src_w > 0 and src_h > 0:
            src_ratio = src_w / src_h
            target_ratio = float(width) / float(height)
            ratio_delta = abs(src_ratio - target_ratio) / max(src_ratio, target_ratio)
            # If the saved calibration came from a materially different framing,
            # it will misalign in UI overlays and warps. Ignore in that case.
            if ratio_delta > 0.08:
                log(
                    f"Ignoring saved bounds due to aspect-ratio mismatch: "
                    f"saved={src_w:.0f}x{src_h:.0f} target={width}x{height}"
                )
                return None

    normalized = bounds.get("normalized_corners")
    if normalized and len(normalized) == 4:
        return denormalize_quad(normalized, width, height)

    corners = bounds.get("corners")
    if not corners or not source_dimensions or len(source_dimensions) != 2:
        return None

    src_w, src_h = source_dimensions
    normalized = [[float(x) / float(src_w), float(y) / float(src_h)] for x, y in corners]
    return denormalize_quad(normalized, width, height)


def detect_document_quad(image):
    quad, confidence, source = detect_document_quad_opencv(image)
    saved_quad = load_saved_bounds_for_shape(image.shape[1], image.shape[0])
    saved_confidence = 0.62 if saved_quad is not None else 0.0

    if quad is None and saved_quad is not None:
        log("Using saved bounds because OpenCV detection failed")
        return saved_quad, saved_confidence, "saved_bounds"

    if saved_quad is not None and confidence < 0.55:
        log(f"OpenCV confidence {confidence:.3f} below threshold; using saved bounds")
        return saved_quad, saved_confidence, "saved_bounds"

    if quad is not None:
        log(f"Using detected quad source={source} confidence={confidence:.3f}")
    return quad, confidence, source


def transform_document(image, corners, output_size=2000):
    ordered, avg_w, avg_h = compute_quad_metrics(corners)
    out_w = max(1, int(round(avg_w)))
    out_h = max(1, int(round(avg_h)))

    max_dim = max(out_w, out_h)
    if max_dim > output_size:
        scale = output_size / max_dim
        out_w = max(1, int(round(out_w * scale)))
        out_h = max(1, int(round(out_h * scale)))

    destination = np.array([
        [0, 0],
        [out_w - 1, 0],
        [out_w - 1, out_h - 1],
        [0, out_h - 1],
    ], dtype=np.float32)

    matrix = cv2.getPerspectiveTransform(ordered, destination)
    return cv2.warpPerspective(image, matrix, (out_w, out_h))


def contrast_stretch(image):
    if len(image.shape) == 2:
        lo = np.percentile(image, 1)
        hi = np.percentile(image, 99)
        if hi - lo > 0:
            return np.clip((image.astype(np.float32) - lo) * 255.0 / (hi - lo), 0, 255).astype(np.uint8)
        return image

    stretched = image.copy()
    for channel in range(stretched.shape[2]):
        stretched[:, :, channel] = contrast_stretch(stretched[:, :, channel])
    return stretched


def normalize_lighting_gray(gray):
    background = cv2.GaussianBlur(gray, (0, 0), 31)
    normalized = cv2.divide(gray, background, scale=255)
    return np.clip(normalized, 0, 255).astype(np.uint8)


def enhance_scan(image, mode):
    if mode == "color":
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
        l_channel, a_channel, b_channel = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        l_channel = clahe.apply(l_channel)
        color = cv2.cvtColor(cv2.merge((l_channel, a_channel, b_channel)), cv2.COLOR_LAB2BGR)
        return contrast_stretch(color)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = normalize_lighting_gray(gray)
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
    gray = clahe.apply(gray)

    if mode == "grayscale":
        return contrast_stretch(gray)

    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        35,
        11,
    )
    return cv2.medianBlur(binary, 3)


def resize_if_needed(image, max_dimension):
    height, width = image.shape[:2]
    if max(height, width) <= max_dimension:
        return image
    if width > height:
        new_w, new_h = max_dimension, int(height * max_dimension / width)
    else:
        new_h, new_w = max_dimension, int(width * max_dimension / height)
    return cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)


def post_process(image, max_dimension, mode):
    image = enhance_scan(image, mode)
    return resize_if_needed(image, max_dimension)


def load_input_image(image_path):
    image = cv2.imread(image_path, cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise RuntimeError(f"Failed to read image: {image_path}")
    return image


def save_bounds(corners, width, height):
    ordered, avg_w, avg_h = compute_quad_metrics(corners)
    bbox = [
        float(ordered[:, 0].min()),
        float(ordered[:, 1].min()),
        float(ordered[:, 0].max()),
        float(ordered[:, 1].max()),
    ]
    config = load_config()
    config["saved_bounds"] = {
        "type": "scanner_calibrated",
        "bbox": bbox,
        "corners": [[float(x), float(y)] for x, y in ordered],
        "normalized_corners": normalize_quad(ordered, width, height),
        "source_dimensions": [int(width), int(height)],
        "area": float(cv2.contourArea(ordered)),
        "aspect_ratio": float(avg_w / avg_h) if avg_h > 0 else 0.0,
    }
    save_config(config)
    log(f"Saved scanner bounds for source_dimensions={width}x{height}")
    return config["saved_bounds"]


def clear_saved_bounds():
    config = load_config()
    had_bounds = "saved_bounds" in config
    config.pop("saved_bounds", None)
    save_config(config)
    if had_bounds:
        log("Cleared saved scanner bounds")
    else:
        log("No saved scanner bounds to clear")
    return had_bounds


def process_input_image(args):
    image = load_input_image(args.input_image)
    height, width = image.shape[:2]

    if args.detect_document:
        quad, confidence, source = detect_document_quad(image)
        payload = {
            "quad": normalize_quad(quad, width, height) if quad is not None else None,
            "confidence": confidence,
            "source": source,
            "image_width": width,
            "image_height": height,
        }
        json.dump(payload, sys.stdout)
        return

    if args.save_bounds:
        quad = denormalize_quad(parse_quad_arg(args.quad), width, height) if args.quad else None
        if quad is None:
            quad, _, _ = detect_document_quad(image)
        if quad is None:
            raise RuntimeError("No document quad available to save")
        saved = save_bounds(quad, width, height)
        json.dump({
            "saved": True,
            "normalized_quad": saved["normalized_corners"],
            "image_width": width,
            "image_height": height,
        }, sys.stdout)
        return

    if args.scan_document:
        if not args.output:
            raise RuntimeError("--output is required for --scan-document")

        quad = denormalize_quad(parse_quad_arg(args.quad), width, height) if args.quad else None
        if quad is None:
            quad, _, _ = detect_document_quad(image)
        if quad is None:
            raise RuntimeError("No document quad available for scan")

        warped = transform_document(image, quad, output_size=args.max_dimension)
        result = resize_if_needed(warped, args.max_dimension)

        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        cv2.imwrite(args.output, result, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])

        result_h, result_w = result.shape[:2]
        json.dump({
            "path": args.output,
            "width": result_w,
            "height": result_h,
            "transformed": True,
        }, sys.stdout)
        return

    raise RuntimeError("Input image mode requires one of --detect-document, --scan-document, or --save-bounds")


def apply_capture_crop_and_rotation(frame, args):
    if args.crop:
        cx, cy, cw, ch = [float(v) for v in args.crop.split(",")]
        frame_h, frame_w = frame.shape[:2]
        x1 = int(frame_w * cx / 100)
        y1 = int(frame_h * cy / 100)
        x2 = int(frame_w * (cx + cw) / 100)
        y2 = int(frame_h * (cy + ch) / 100)
        frame = frame[y1:y2, x1:x2]
        log(f"Cropped to {frame.shape[1]}x{frame.shape[0]}")

    if args.rotate == 90:
        frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    elif args.rotate == 180:
        frame = cv2.rotate(frame, cv2.ROTATE_180)
    elif args.rotate == 270:
        frame = cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return frame


def process_camera_capture(args):
    mode = HIGH_MODE if args.high else MID_MODE if args.mid else LOW_MODE
    cap = None
    try:
        cap = setup_camera(args.camera, mode)
        log(f"Capturing {args.stack} frames...")
        frame = capture_stacked(cap, args.stack)
        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        frame = apply_capture_crop_and_rotation(frame, args)

        transformed = False
        if args.use_bounds:
            bounds = load_saved_bounds_for_shape(frame.shape[1], frame.shape[0])
            if bounds is not None:
                log("Applying perspective correction from saved bounds...")
                frame = transform_document(frame, bounds, output_size=args.max_dimension)
                transformed = True

        scan_mode = "color" if args.no_grayscale else "grayscale"
        result = post_process(frame, max_dimension=args.max_dimension, mode=scan_mode)

        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        cv2.imwrite(args.output, result, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])

        result_h, result_w = result.shape[:2]
        size_bytes = os.path.getsize(args.output)
        json.dump({
            "path": args.output,
            "width": result_w,
            "height": result_h,
            "size_bytes": size_bytes,
            "capture_resolution": f"{actual_w}x{actual_h}",
            "stacked_frames": args.stack,
            "transformed": transformed,
            "grayscale": not args.no_grayscale,
        }, sys.stdout)
        print(file=sys.stderr)
        log(f"Saved: {args.output} ({result_w}x{result_h}, {size_bytes // 1024} KB)")
    finally:
        if cap is not None:
            cap.release()


def main():
    parser = argparse.ArgumentParser(description="Seashell Desk camera capture and scanner")
    parser.add_argument("--output", "-o", help="Output JPEG path")
    parser.add_argument("--input-image", help="Read an existing image instead of capturing from camera")
    parser.add_argument("--detect-document", action="store_true", help="Detect a document quad from --input-image")
    parser.add_argument("--scan-document", action="store_true", help="Perspective-warp a document from --input-image")
    parser.add_argument("--save-bounds", action="store_true", help="Save a quad from --input-image as scanner bounds")
    parser.add_argument("--clear-bounds", action="store_true", help="Clear saved scanner bounds from config")
    parser.add_argument("--quad", type=str, help="Normalized quad as x,y;x,y;x,y;x,y")
    parser.add_argument("--camera", type=int, default=0, help="Camera index (default: 0)")
    parser.add_argument("--stack", type=int, default=3, help="Frames to stack (default: 3)")
    parser.add_argument("--max-dimension", type=int, default=2000, help="Max output dimension (default: 2000)")
    parser.add_argument("--jpeg-quality", type=int, default=90, help="JPEG quality 1-100 (default: 90)")
    parser.add_argument("--use-bounds", action="store_true", help="Apply saved perspective correction")
    parser.add_argument("--no-enhance", action="store_true", help="Retained for backward compatibility")
    parser.add_argument("--no-grayscale", action="store_true", help="Keep color output")
    parser.add_argument("--high", action="store_true", help="Use high-res mode (4656x3496)")
    parser.add_argument("--mid", action="store_true", help="Use mid-res mode (3264x2448)")
    parser.add_argument("--crop", type=str, default=None, help="Crop region as x,y,w,h in percent of frame")
    parser.add_argument("--rotate", type=int, default=0, choices=[0, 90, 180, 270], help="Rotate image clockwise")
    args = parser.parse_args()

    try:
        if args.clear_bounds:
            clear_saved_bounds()
            json.dump({"cleared": True}, sys.stdout)
            return

        if args.input_image:
            process_input_image(args)
        else:
            if not args.output:
                raise RuntimeError("--output is required when capturing from camera")
            process_camera_capture(args)
    except Exception as error:
        json.dump({"error": str(error)}, sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
