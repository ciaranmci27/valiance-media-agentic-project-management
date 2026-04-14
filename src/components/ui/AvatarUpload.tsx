'use client';

import { useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { AvatarCropModal } from './AvatarCropModal';
import { Camera, Loader2, X } from 'lucide-react';

interface AvatarUploadProps {
  name: string;
  currentSrc?: string;
  size?: 'md' | 'lg';
  /** Called with a cropped, compressed 256x256 JPEG blob ready for upload. */
  onCropped: (blob: Blob) => void;
  uploading?: boolean;
  onRemove?: () => void;
}

const sizeMap = {
  md: 'w-16 h-16',
  lg: 'w-20 h-20',
};

export function AvatarUpload({
  name,
  currentSrc,
  size = 'lg',
  onCropped,
  uploading = false,
  onRemove,
}: AvatarUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCropFile(file);
      // Reset so same file can be re-selected
      e.target.value = '';
    }
  };

  const handleCrop = (blob: Blob) => {
    setCropFile(null);
    onCropped(blob);
  };

  return (
    <>
      <div className="relative group inline-block">
        <div className={`${sizeMap[size]} rounded-full overflow-hidden`}>
          <Avatar
            name={name}
            src={currentSrc}
            size={size === 'lg' ? 'lg' : 'md'}
            className="!w-full !h-full !text-lg"
          />
        </div>

        {/* Hover overlay */}
        {!uploading && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="absolute inset-0 rounded-full bg-black/30 sm:bg-black/0 sm:group-hover:bg-black/40 sm:focus-visible:bg-black/40 flex items-center justify-center transition-all cursor-pointer"
          >
            <Camera
              size={size === 'lg' ? 20 : 16}
              className="text-white sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 transition-opacity"
            />
          </button>
        )}

        {/* Loading overlay */}
        {uploading && (
          <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center">
            <Loader2 size={20} className="text-white animate-spin" />
          </div>
        )}

        {/* Remove button */}
        {currentSrc && onRemove && !uploading && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white flex items-center justify-center sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 transition-opacity hover:bg-red-600"
          >
            <X size={12} />
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleChange}
          className="hidden"
        />
      </div>

      <AvatarCropModal
        file={cropFile}
        onCrop={handleCrop}
        onCancel={() => setCropFile(null)}
      />
    </>
  );
}
