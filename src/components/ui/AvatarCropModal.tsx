'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from './Button';
import Modal from './Modal';

interface AvatarCropModalProps {
  file: File | null;
  onCrop: (blob: Blob) => void;
  onCancel: () => void;
}

const OUTPUT_SIZE = 256;
const QUALITY = 0.8;
const CONTAINER_SIZE = 280;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

export function AvatarCropModal({ file, onCrop, onCancel }: AvatarCropModalProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [naturalW, setNaturalW] = useState(0);
  const [naturalH, setNaturalH] = useState(0);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, panStartX: 0, panStartY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Load file into image
  useEffect(() => {
    if (!file) {
      setImgSrc(null);
      setNaturalW(0);
      setNaturalH(0);
      imgRef.current = null;
      return;
    }

    const url = URL.createObjectURL(file);
    setImgSrc(url);
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });

    const img = new Image();
    img.onload = () => {
      setNaturalW(img.width);
      setNaturalH(img.height);
      imgRef.current = img;
    };
    img.src = url;

    return () => URL.revokeObjectURL(url);
  }, [file]);

  const baseScale = naturalW && naturalH
    ? CONTAINER_SIZE / Math.min(naturalW, naturalH)
    : 1;

  const clampPan = useCallback((px: number, py: number, z: number) => {
    if (!naturalW || !naturalH) return { x: 0, y: 0 };
    const es = (CONTAINER_SIZE / Math.min(naturalW, naturalH)) * z;
    const maxPanX = Math.max(0, (naturalW * es - CONTAINER_SIZE) / 2);
    const maxPanY = Math.max(0, (naturalH * es - CONTAINER_SIZE) / 2);
    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, px)),
      y: Math.max(-maxPanY, Math.min(maxPanY, py)),
    };
  }, [naturalW, naturalH]);

  // Pointer handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    dragRef.current = { startX: e.clientX, startY: e.clientY, panStartX: pan.x, panStartY: pan.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const { startX, startY, panStartX, panStartY } = dragRef.current;
    setPan(clampPan(panStartX + e.clientX - startX, panStartY + e.clientY - startY, zoom));
  };

  const handlePointerUp = () => setDragging(false);

  const handleZoom = useCallback((z: number) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    setZoom(clamped);
    setPan(prev => clampPan(prev.x, prev.y, clamped));
  }, [clampPan]);

  // Wheel zoom — native listener so we can preventDefault (React wheel is passive)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      handleZoom(zoomRef.current + delta);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [handleZoom]);

  const handleSave = () => {
    const img = imgRef.current;
    if (!img) return;

    const es = baseScale * zoom;
    const viewSize = CONTAINER_SIZE / es;
    // Map viewport center to image coordinates, accounting for pan
    const sx = naturalW / 2 - (CONTAINER_SIZE / 2 + pan.x) / es;
    const sy = naturalH / 2 - (CONTAINER_SIZE / 2 + pan.y) / es;

    // Preserve transparency for PNG inputs
    const isPng = file?.type === 'image/png';
    const outMime = isPng ? 'image/png' : 'image/jpeg';

    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // For JPEG, fill white background first (no transparency support)
    if (!isPng) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    }

    ctx.drawImage(img, sx, sy, viewSize, viewSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    canvas.toBlob(
      (blob) => { if (blob) onCrop(blob); },
      outMime,
      isPng ? undefined : QUALITY
    );
  };

  if (!file || !imgSrc) return null;

  const es = baseScale * zoom;

  return (
    <Modal isOpen={!!file} onClose={onCancel} title="Crop Avatar" size="sm">
      <div className="space-y-4">
        {/* Crop area — circular viewport */}
        <div className="flex justify-center">
          <div
            ref={containerRef}
            className="relative overflow-hidden rounded-full bg-zinc-900 cursor-grab active:cursor-grabbing select-none touch-none"
            style={{ width: CONTAINER_SIZE, height: CONTAINER_SIZE }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            {naturalW > 0 && (
              <img
                src={imgSrc}
                alt="Crop preview"
                draggable={false}
                className="absolute pointer-events-none"
                style={{
                  width: naturalW * es,
                  height: naturalH * es,
                  left: '50%',
                  top: '50%',
                  transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px)`,
                }}
              />
            )}
          </div>
        </div>

        {/* Zoom slider */}
        <div className="flex items-center gap-3 px-2">
          <button
            type="button"
            onClick={() => handleZoom(zoom - 0.25)}
            className="p-1 rounded text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            <ZoomOut size={18} />
          </button>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => handleZoom(parseFloat(e.target.value))}
            className="flex-1 accent-indigo-600 h-1.5"
          />
          <button
            type="button"
            onClick={() => handleZoom(zoom + 0.25)}
            className="p-1 rounded text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            <ZoomIn size={18} />
          </button>
        </div>

        <p className="text-xs text-zinc-400 text-center">Drag to reposition. Scroll or use slider to zoom.</p>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
