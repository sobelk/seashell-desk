import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionButton, Card, Label, Row, SelectInput } from './components.js'

interface UploadResult {
  filename: string
  relativePath: string
  sizeBytes: number
}

type QuadPoint = [number, number]
type ScannerQuad = [QuadPoint, QuadPoint, QuadPoint, QuadPoint]

interface ProcessedPreview {
  blob: Blob
  objectUrl: string
  width: number
  height: number
}

interface SessionPhoto {
  id: string
  blob: Blob
  objectUrl: string
  width: number
  height: number
  capturedAt: string
  uploadState: string | null
  detectionState: string | null
  processingState: string | null
  calibrationState: string | null
  isUploading: boolean
  isDetecting: boolean
  isProcessing: boolean
  isCalibrating: boolean
  detectedQuad: ScannerQuad | null
  adjustedQuad: ScannerQuad | null
  processedPreview: ProcessedPreview | null
  detectionConfidence: number | null
  detectionSource: string | null
  usedFallback: boolean
}

interface CameraPanelProps {
  uploadInputPhoto: (photo: Blob, options?: { filenameBase?: string }) => Promise<UploadResult>
  detectScannerDocument: (photo: Blob) => Promise<{
    quad: ScannerQuad | null
    confidence: number
    source: string
    imageWidth: number
    imageHeight: number
    usedFallback: boolean
  }>
  scanScannerDocument: (
    photo: Blob,
    options: { quad: ScannerQuad },
  ) => Promise<{ imageBase64: string; mimeType: 'image/jpeg'; width: number; height: number }>
  saveScannerBounds: (photo: Blob, quad: ScannerQuad) => Promise<{ saved: boolean }>
  clearScannerBounds: () => Promise<{ cleared: boolean }>
}

interface ResolutionPreset {
  id: string
  label: string
  width: number
  height: number
}

const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { id: '640x480', label: '640x480 (SD)', width: 640, height: 480 },
  { id: '1280x720', label: '1280x720 (HD)', width: 1280, height: 720 },
  { id: '1920x1080', label: '1920x1080 (Full HD)', width: 1920, height: 1080 },
  { id: '2560x1440', label: '2560x1440 (QHD)', width: 2560, height: 1440 },
  { id: '3840x2160', label: '3840x2160 (4K)', width: 3840, height: 2160 },
]
const DEFAULT_RESOLUTION = RESOLUTION_PRESETS[2]!

function formatDeviceLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `Camera ${index + 1}`
}

function describeResolution(width?: number, height?: number): string | null {
  if (!width || !height) return null
  return `${width}x${height}`
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to encode camera frame'))
        return
      }
      resolve(blob)
    }, 'image/jpeg', 0.92)
  })
}

function makeTimestampId(): string {
  return new Date().toISOString()
}

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function buildFilenameBase(timestamp: string): string {
  return `camera-scan-${timestamp.replace(/[:.]/g, '-').slice(0, 19)}`
}

function quadPointsToSvg(quad: ScannerQuad, imageWidth: number, imageHeight: number): string {
  return quad.map(([x, y]) => `${x * imageWidth},${y * imageHeight}`).join(' ')
}

function clampPoint(x: number, y: number): QuadPoint {
  return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]
}

type Rotate90 = 'cw' | 'ccw'

async function rotateImageBlob90(blob: Blob, direction: Rotate90): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob)
  const w = bitmap.width
  const h = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = h
  canvas.height = w
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    throw new Error('Canvas rendering context unavailable')
  }
  if (direction === 'cw') {
    context.translate(h, 0)
    context.rotate(Math.PI / 2)
  } else {
    context.translate(0, w)
    context.rotate(-Math.PI / 2)
  }
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const rotated = await canvasToBlob(canvas)
  return { blob: rotated, width: canvas.width, height: canvas.height }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: mimeType })
}

function formatDetectionMeta(photo: SessionPhoto): string | null {
  if (photo.detectionConfidence == null || !photo.detectionSource) return null
  const percent = Math.round(photo.detectionConfidence * 100)
  const fallback = photo.usedFallback ? ' (Gemini fallback)' : ''
  return `Detection source: ${photo.detectionSource}, confidence: ${percent}%${fallback}`
}

export function CameraPanel({
  uploadInputPhoto,
  detectScannerDocument,
  scanScannerDocument,
  saveScannerBounds,
  clearScannerBounds,
}: CameraPanelProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const photoUrlsRef = useRef<string[]>([])
  const photosRef = useRef<SessionPhoto[]>([])
  const overlayRef = useRef<SVGSVGElement | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [selectedResolutionId, setSelectedResolutionId] = useState('1920x1080')
  const [activeResolution, setActiveResolution] = useState<{ width?: number; height?: number }>({})
  const [status, setStatus] = useState('Starting camera preview...')
  const [error, setError] = useState<string | null>(null)
  const [captureState, setCaptureState] = useState<string | null>(null)
  const [isCapturing, setIsCapturing] = useState(false)
  const [rotateBusy, setRotateBusy] = useState<Rotate90 | null>(null)
  const [isClearingBounds, setIsClearingBounds] = useState(false)
  const [photos, setPhotos] = useState<SessionPhoto[]>([])
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null)
  const [dragState, setDragState] = useState<{ photoId: string; pointIndex: number; pointerId: number } | null>(null)

  const selectedResolution = useMemo(
    () => RESOLUTION_PRESETS.find((preset) => preset.id === selectedResolutionId) ?? DEFAULT_RESOLUTION,
    [selectedResolutionId],
  )

  const refreshDevices = useCallback(async () => {
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.enumerateDevices) return
    const nextDevices = (await mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === 'videoinput',
    )
    setDevices(nextDevices)
  }, [])

  const stopStream = useCallback(() => {
    const current = streamRef.current
    if (!current) return
    current.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const revokeProcessedPreview = useCallback((preview: ProcessedPreview | null) => {
    if (preview?.objectUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(preview.objectUrl)
    }
  }, [])

  useEffect(() => {
    photosRef.current = photos
  }, [photos])

  useEffect(() => () => {
    photoUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    photosRef.current.forEach((photo) => revokeProcessedPreview(photo.processedPreview))
  }, [revokeProcessedPreview])

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.getUserMedia) {
      setError('This browser does not expose camera access APIs.')
      setStatus('Camera preview unavailable')
      return
    }

    let cancelled = false

    const startPreview = async () => {
      setError(null)
      setCaptureState(null)
      setStatus('Starting camera preview...')

      try {
        const stream = await mediaDevices.getUserMedia({
          audio: false,
          video: {
            deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
            width: { ideal: selectedResolution.width },
            height: { ideal: selectedResolution.height },
          },
        })

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        stopStream()
        streamRef.current = stream

        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play().catch(() => {})
        }

        await refreshDevices()

        const track = stream.getVideoTracks()[0]
        const settings = track?.getSettings() ?? {}
        setActiveResolution({ width: settings.width, height: settings.height })
        if (!selectedDeviceId && typeof settings.deviceId === 'string' && settings.deviceId) {
          setSelectedDeviceId(settings.deviceId)
        }
        setStatus('Camera preview active')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setStatus('Unable to access camera')
        stopStream()
      }
    }

    void startPreview()

    return () => {
      cancelled = true
      stopStream()
    }
  }, [refreshDevices, selectedDeviceId, selectedResolution, stopStream])

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices
    if (!mediaDevices?.addEventListener) return

    const onDeviceChange = () => {
      void refreshDevices()
    }

    mediaDevices.addEventListener('devicechange', onDeviceChange)
    void refreshDevices()

    return () => {
      mediaDevices.removeEventListener('devicechange', onDeviceChange)
    }
  }, [refreshDevices])

  const updatePhoto = useCallback((
    photoId: string,
    updater: (photo: SessionPhoto) => SessionPhoto,
  ) => {
    setPhotos((current) => current.map((photo) => (photo.id === photoId ? updater(photo) : photo)))
  }, [])

  const selectedPhoto = photos.find((photo) => photo.id === selectedPhotoId) ?? photos[0] ?? null

  useEffect(() => {
    if (!selectedPhotoId && photos.length > 0) {
      setSelectedPhotoId(photos[0]!.id)
    }
  }, [photos, selectedPhotoId])

  const onCapture = useCallback(async () => {
    const video = videoRef.current
    if (!video) return

    if (!video.videoWidth || !video.videoHeight) {
      setCaptureState('Camera preview is not ready yet.')
      return
    }

    setIsCapturing(true)
    setCaptureState('Capturing photo...')

    try {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas rendering context unavailable')

      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const photo = await canvasToBlob(canvas)
      const objectUrl = URL.createObjectURL(photo)
      photoUrlsRef.current.push(objectUrl)

      const nextPhoto: SessionPhoto = {
        id: crypto.randomUUID(),
        blob: photo,
        objectUrl,
        width: canvas.width,
        height: canvas.height,
        capturedAt: makeTimestampId(),
        uploadState: null,
        detectionState: null,
        processingState: null,
        calibrationState: null,
        isUploading: false,
        isDetecting: false,
        isProcessing: false,
        isCalibrating: false,
        detectedQuad: null,
        adjustedQuad: null,
        processedPreview: null,
        detectionConfidence: null,
        detectionSource: null,
        usedFallback: false,
      }

      setPhotos((current) => [nextPhoto, ...current])
      setSelectedPhotoId(nextPhoto.id)
      setCaptureState(`Captured ${canvas.width}x${canvas.height}. Detect, adjust, then send the scan to input.`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setCaptureState(`Capture failed: ${message}`)
    } finally {
      setIsCapturing(false)
    }
  }, [])

  const onDetectDocument = useCallback(async () => {
    if (!selectedPhoto) return

    updatePhoto(selectedPhoto.id, (photo) => {
      revokeProcessedPreview(photo.processedPreview)
      return {
        ...photo,
        isDetecting: true,
        detectionState: 'Detecting document quad...',
        processingState: null,
        processedPreview: null,
      }
    })

    try {
      const result = await detectScannerDocument(selectedPhoto.blob)
      updatePhoto(selectedPhoto.id, (photo) => ({
        ...photo,
        isDetecting: false,
        detectionState: result.quad
          ? 'Document detected. Adjust corners if needed, then apply correction.'
          : 'No document quad detected.',
        detectedQuad: result.quad,
        adjustedQuad: result.quad,
        detectionConfidence: result.confidence,
        detectionSource: result.source,
        usedFallback: result.usedFallback,
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updatePhoto(selectedPhoto.id, (photo) => ({
        ...photo,
        isDetecting: false,
        detectionState: `Detection failed: ${message}`,
        detectedQuad: null,
        adjustedQuad: null,
        detectionConfidence: null,
        detectionSource: null,
        usedFallback: false,
      }))
    }
  }, [detectScannerDocument, revokeProcessedPreview, selectedPhoto, updatePhoto])

  const onRotateProcessedPreview = useCallback(async (direction: Rotate90) => {
    if (!selectedPhoto?.processedPreview) return

    const photoId = selectedPhoto.id
    setRotateBusy(direction)
    try {
      const { blob: newBlob, width: newWidth, height: newHeight } = await rotateImageBlob90(
        selectedPhoto.processedPreview.blob,
        direction,
      )
      const objectUrl = URL.createObjectURL(newBlob)
      const label = direction === 'cw' ? 'clockwise' : 'counter-clockwise'

      updatePhoto(photoId, (photo) => {
        if (!photo.processedPreview) return photo
        revokeProcessedPreview(photo.processedPreview)
        return {
          ...photo,
          processedPreview: {
            blob: newBlob,
            objectUrl,
            width: newWidth,
            height: newHeight,
          },
          processingState: `Corrected image rotated 90° ${label}.`,
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updatePhoto(photoId, (photo) => ({
        ...photo,
        processingState: `Rotation failed: ${message}`,
      }))
    } finally {
      setRotateBusy(null)
    }
  }, [revokeProcessedPreview, selectedPhoto, updatePhoto])

  const onApplyCorrection = useCallback(async () => {
    if (!selectedPhoto?.adjustedQuad) return

    updatePhoto(selectedPhoto.id, (photo) => ({
      ...photo,
      isProcessing: true,
      processingState: 'Applying perspective correction...',
    }))

    try {
      const result = await scanScannerDocument(selectedPhoto.blob, {
        quad: selectedPhoto.adjustedQuad,
      })
      const blob = base64ToBlob(result.imageBase64, result.mimeType)
      const objectUrl = URL.createObjectURL(blob)

      updatePhoto(selectedPhoto.id, (photo) => {
        revokeProcessedPreview(photo.processedPreview)
        return {
          ...photo,
          isProcessing: false,
          processingState: `Processed preview ready (${result.width}x${result.height}).`,
          processedPreview: {
            blob,
            objectUrl,
            width: result.width,
            height: result.height,
          },
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updatePhoto(selectedPhoto.id, (photo) => ({
        ...photo,
        isProcessing: false,
        processingState: `Processing failed: ${message}`,
      }))
    }
  }, [revokeProcessedPreview, scanScannerDocument, selectedPhoto, updatePhoto])

  const onSendToInput = useCallback(async () => {
    if (!selectedPhoto?.processedPreview) return

    updatePhoto(selectedPhoto.id, (photo) => ({
      ...photo,
      isUploading: true,
      uploadState: 'Sending processed scan to desk input...',
    }))

    try {
      const result = await uploadInputPhoto(selectedPhoto.processedPreview.blob, {
        filenameBase: buildFilenameBase(selectedPhoto.capturedAt),
      })
      const sizeKb = Math.max(1, Math.round(result.sizeBytes / 1024))
      updatePhoto(selectedPhoto.id, (photo) => ({
        ...photo,
        isUploading: false,
        uploadState: `Saved ${result.relativePath} (${sizeKb} KB)`,
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updatePhoto(selectedPhoto.id, (photo) => ({
        ...photo,
        isUploading: false,
        uploadState: `Send failed: ${message}`,
      }))
    }
  }, [selectedPhoto, updatePhoto, uploadInputPhoto])

  const onSaveBounds = useCallback(async () => {
    if (!selectedPhoto?.adjustedQuad) return

    updatePhoto(selectedPhoto.id, (photo) => ({
      ...photo,
      isCalibrating: true,
      calibrationState: 'Saving this scan area as the fixed scanner bounds...',
    }))

    try {
      await saveScannerBounds(selectedPhoto.blob, selectedPhoto.adjustedQuad)
      updatePhoto(selectedPhoto.id, (photo) => ({
        ...photo,
        isCalibrating: false,
        calibrationState: 'Saved scanner bounds. Future detections can reuse this fixed scan area.',
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      updatePhoto(selectedPhoto.id, (photo) => ({
        ...photo,
        isCalibrating: false,
        calibrationState: `Saving scanner bounds failed: ${message}`,
      }))
    }
  }, [saveScannerBounds, selectedPhoto, updatePhoto])

  const onClearBounds = useCallback(async () => {
    setIsClearingBounds(true)
    try {
      await clearScannerBounds()
      setCaptureState('Cleared saved scanner bounds. Detection will no longer use fixed calibration until you lock a new scan area.')
      if (selectedPhoto) {
        updatePhoto(selectedPhoto.id, (photo) => ({
          ...photo,
          calibrationState: 'Saved scan area cleared.',
        }))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setCaptureState(`Clearing saved scanner bounds failed: ${message}`)
    } finally {
      setIsClearingBounds(false)
    }
  }, [clearScannerBounds, selectedPhoto, updatePhoto])

  const onResetCorners = useCallback(() => {
    if (!selectedPhoto?.detectedQuad) return
    updatePhoto(selectedPhoto.id, (photo) => ({
      ...photo,
      adjustedQuad: photo.detectedQuad,
      processingState: 'Corners reset to the latest detected quad.',
    }))
  }, [selectedPhoto, updatePhoto])

  const updateDragPoint = useCallback((photoId: string, pointIndex: number, clientX: number, clientY: number) => {
    const rect = overlayRef.current?.getBoundingClientRect()
    if (!rect) return

    const x = (clientX - rect.left) / rect.width
    const y = (clientY - rect.top) / rect.height
    const point = clampPoint(x, y)

    updatePhoto(photoId, (photo) => {
      if (!photo.adjustedQuad) return photo
      const nextQuad = [...photo.adjustedQuad] as ScannerQuad
      nextQuad[pointIndex] = point
      return {
        ...photo,
        adjustedQuad: nextQuad,
        processingState: 'Corners adjusted. Apply correction to refresh the processed preview.',
      }
    })
  }, [updatePhoto])

  const onHandlePointerDown = useCallback((
    event: React.PointerEvent<SVGCircleElement>,
    photoId: string,
    pointIndex: number,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    overlayRef.current?.setPointerCapture(event.pointerId)
    setDragState({ photoId, pointIndex, pointerId: event.pointerId })
    updateDragPoint(photoId, pointIndex, event.clientX, event.clientY)
  }, [updateDragPoint])

  const onOverlayPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState) return
    if (event.pointerId !== dragState.pointerId) return
    event.preventDefault()
    updateDragPoint(dragState.photoId, dragState.pointIndex, event.clientX, event.clientY)
  }, [dragState, updateDragPoint])

  const onOverlayPointerEnd = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragState) return
    if (event.pointerId !== dragState.pointerId) return
    overlayRef.current?.releasePointerCapture(event.pointerId)
    setDragState(null)
  }, [dragState])

  const activeResolutionText = describeResolution(activeResolution.width, activeResolution.height)
  const hasDevices = devices.length > 0
  const activeQuad = selectedPhoto?.adjustedQuad ?? null

  return (
    <div className="grid">
      <Card>
        <h3>Camera</h3>
        <div className="stack">
          <div>
            <Label>Camera device</Label>
            <SelectInput
              value={selectedDeviceId}
              onChange={(event) => setSelectedDeviceId(event.currentTarget.value)}
              disabled={!hasDevices}
            >
              {!selectedDeviceId && <option value="">Default camera</option>}
              {devices.map((device, index) => (
                <option key={device.deviceId || `${device.kind}-${index}`} value={device.deviceId}>
                  {formatDeviceLabel(device, index)}
                </option>
              ))}
            </SelectInput>
          </div>

          <div>
            <Label>Requested resolution</Label>
            <SelectInput
              value={selectedResolutionId}
              onChange={(event) => setSelectedResolutionId(event.currentTarget.value)}
            >
              {RESOLUTION_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </SelectInput>
          </div>

          <Row className="muted">
            <span>{status}</span>
            {activeResolutionText && <span>active: {activeResolutionText}</span>}
          </Row>
          {error && <div className="camera-error">{error}</div>}
          {captureState && <div className="muted">{captureState}</div>}

          <ActionButton onClick={onCapture} disabled={isCapturing || !!error}>
            {isCapturing ? 'Capturing...' : 'Take Photo'}
          </ActionButton>
        </div>
      </Card>

      <Card>
        <h3>Preview</h3>
        <div className="camera-preview-shell">
          <video ref={videoRef} className="camera-preview" autoPlay muted playsInline />
        </div>
        <p className="muted">
          Photos stay local to this browser session until you generate a corrected scan and explicitly send it to `desk/input/`.
        </p>
      </Card>

      <Card className="card-wide">
        <h3>Photos</h3>
        {photos.length === 0 ? (
          <p className="muted">No photos taken yet in this session.</p>
        ) : (
          <div className="photos-layout">
            <div className="photo-strip">
              {photos.map((photo) => (
                <button
                  key={photo.id}
                  type="button"
                  className={`photo-thumb ${selectedPhoto?.id === photo.id ? 'selected' : ''}`}
                  onClick={() => setSelectedPhotoId(photo.id)}
                >
                  <img src={photo.objectUrl} alt={`Captured at ${formatTimestamp(photo.capturedAt)}`} />
                  <span>{formatTimestamp(photo.capturedAt)}</span>
                </button>
              ))}
            </div>

            {selectedPhoto && (
              <div className="photo-detail">
                <div className="stack">
                  <Row className="wrap-row">
                    <ActionButton
                      onClick={onDetectDocument}
                      disabled={
                        selectedPhoto.isDetecting
                        || selectedPhoto.isProcessing
                        || selectedPhoto.isUploading
                      }
                    >
                      {selectedPhoto.isDetecting ? 'Detecting...' : 'Detect document'}
                    </ActionButton>
                    <ActionButton
                      onClick={onApplyCorrection}
                      disabled={
                        !selectedPhoto.adjustedQuad
                        || selectedPhoto.isProcessing
                        || selectedPhoto.isDetecting
                      }
                    >
                      {selectedPhoto.isProcessing ? 'Applying...' : 'Apply correction'}
                    </ActionButton>
                    <ActionButton
                      onClick={onResetCorners}
                      disabled={!selectedPhoto.detectedQuad || selectedPhoto.isProcessing}
                    >
                      Reset corners
                    </ActionButton>
                    <ActionButton
                      onClick={onSaveBounds}
                      disabled={
                        !selectedPhoto.adjustedQuad
                        || selectedPhoto.isCalibrating
                        || selectedPhoto.isDetecting
                      }
                    >
                      {selectedPhoto.isCalibrating ? 'Saving area...' : 'Lock scan area'}
                    </ActionButton>
                    <ActionButton
                      onClick={onClearBounds}
                      disabled={isClearingBounds || selectedPhoto.isCalibrating}
                    >
                      {isClearingBounds ? 'Clearing...' : 'Clear saved scan area'}
                    </ActionButton>
                    <ActionButton
                      onClick={onSendToInput}
                      disabled={
                        !selectedPhoto.processedPreview
                        || selectedPhoto.isUploading
                        || selectedPhoto.isProcessing
                        || rotateBusy !== null
                      }
                    >
                      {selectedPhoto.isUploading ? 'Sending...' : 'Send to input'}
                    </ActionButton>
                  </Row>
                </div>

                <div className="scanner-panels">
                  <div>
                    <Label>Raw capture</Label>
                    <div className="captured-photo-shell scanner-editor-shell">
                      <img
                        src={selectedPhoto.objectUrl}
                        alt={`Captured at ${formatTimestamp(selectedPhoto.capturedAt)}`}
                        className="captured-photo"
                      />
                      {activeQuad && (
                        <>
                          <svg
                            ref={overlayRef}
                            className="quad-overlay"
                            viewBox={`0 0 ${selectedPhoto.width} ${selectedPhoto.height}`}
                            preserveAspectRatio="xMinYMin meet"
                            onPointerMove={onOverlayPointerMove}
                            onPointerUp={onOverlayPointerEnd}
                            onPointerCancel={onOverlayPointerEnd}
                            aria-hidden="true"
                          >
                            <polygon
                              points={quadPointsToSvg(activeQuad, selectedPhoto.width, selectedPhoto.height)}
                              className="quad-polygon"
                            />
                            {activeQuad.map((point, index) => (
                              <circle
                                key={`${selectedPhoto.id}-handle-${index}`}
                                className="quad-handle-svg"
                                cx={point[0] * selectedPhoto.width}
                                cy={point[1] * selectedPhoto.height}
                                r="12"
                                onPointerDown={(event) => onHandlePointerDown(event, selectedPhoto.id, index)}
                              />
                            ))}
                          </svg>
                        </>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="processed-preview-header">
                      <Label>Processed preview</Label>
                      {selectedPhoto.processedPreview && (
                        <Row className="wrap-row processed-preview-actions">
                          <ActionButton
                            onClick={() => void onRotateProcessedPreview('ccw')}
                            disabled={selectedPhoto.isUploading || rotateBusy !== null}
                          >
                            {rotateBusy === 'ccw' ? 'Rotating...' : 'Rotate left'}
                          </ActionButton>
                          <ActionButton
                            onClick={() => void onRotateProcessedPreview('cw')}
                            disabled={selectedPhoto.isUploading || rotateBusy !== null}
                          >
                            {rotateBusy === 'cw' ? 'Rotating...' : 'Rotate right'}
                          </ActionButton>
                        </Row>
                      )}
                    </div>
                    <div className="captured-photo-shell processed-preview-shell">
                      {selectedPhoto.processedPreview ? (
                        <img
                          src={selectedPhoto.processedPreview.objectUrl}
                          alt={`Processed scan from ${formatTimestamp(selectedPhoto.capturedAt)}`}
                          className="captured-photo"
                        />
                      ) : (
                        <div className="processed-placeholder muted">
                          Run `Apply correction` after detection to generate the flattened scan preview.
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="muted">
                  Captured {formatTimestamp(selectedPhoto.capturedAt)} at {selectedPhoto.width}x{selectedPhoto.height}
                </div>
                {formatDetectionMeta(selectedPhoto) && <div className="muted">{formatDetectionMeta(selectedPhoto)}</div>}
                {selectedPhoto.detectionState && <div className="muted">{selectedPhoto.detectionState}</div>}
                {selectedPhoto.processingState && <div className="muted">{selectedPhoto.processingState}</div>}
                {selectedPhoto.calibrationState && <div className="muted">{selectedPhoto.calibrationState}</div>}
                {selectedPhoto.uploadState && <div className="muted">{selectedPhoto.uploadState}</div>}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
