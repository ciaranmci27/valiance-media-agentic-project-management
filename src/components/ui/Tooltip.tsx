'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  className?: string;
  /** When true, renders children directly without tooltip functionality */
  disabled?: boolean;
}

export function Tooltip({
  children,
  content,
  position = 'top',
  delay = 200,
  className = '',
  disabled = false,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const [actualPosition, setActualPosition] = useState(position);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const calculatePosition = useCallback(() => {
    if (!triggerRef.current) return;

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipEl = tooltipRef.current;
    const tooltipWidth = tooltipEl?.offsetWidth || 0;
    const tooltipHeight = tooltipEl?.offsetHeight || 0;
    const padding = 8;
    const viewportPadding = 8;

    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    const positions = {
      top: {
        top: triggerRect.top - tooltipHeight - padding,
        left: triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2,
      },
      bottom: {
        top: triggerRect.bottom + padding,
        left: triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2,
      },
      left: {
        top: triggerRect.top + triggerRect.height / 2 - tooltipHeight / 2,
        left: triggerRect.left - tooltipWidth - padding,
      },
      right: {
        top: triggerRect.top + triggerRect.height / 2 - tooltipHeight / 2,
        left: triggerRect.right + padding,
      },
    };

    const fitsInViewport = (pos: 'top' | 'bottom' | 'left' | 'right') => {
      const c = positions[pos];
      switch (pos) {
        case 'top':
          return c.top >= viewportPadding;
        case 'bottom':
          return c.top + tooltipHeight <= viewport.height - viewportPadding;
        case 'left':
          return c.left >= viewportPadding;
        case 'right':
          return c.left + tooltipWidth <= viewport.width - viewportPadding;
      }
    };

    let bestPosition = position;

    if (!fitsInViewport(position)) {
      const opposites: Record<string, 'top' | 'bottom' | 'left' | 'right'> = {
        top: 'bottom',
        bottom: 'top',
        left: 'right',
        right: 'left',
      };

      if (fitsInViewport(opposites[position])) {
        bestPosition = opposites[position];
      } else {
        const allPositions: ('top' | 'bottom' | 'left' | 'right')[] = ['bottom', 'top', 'right', 'left'];
        for (const pos of allPositions) {
          if (fitsInViewport(pos)) {
            bestPosition = pos;
            break;
          }
        }
      }
    }

    let { top, left } = positions[bestPosition];

    if (bestPosition === 'top' || bestPosition === 'bottom') {
      left = Math.max(viewportPadding, Math.min(left, viewport.width - tooltipWidth - viewportPadding));
    }

    if (bestPosition === 'left' || bestPosition === 'right') {
      top = Math.max(viewportPadding, Math.min(top, viewport.height - tooltipHeight - viewportPadding));
    }

    setActualPosition(bestPosition);
    setCoords({ top, left });
  }, [position]);

  const showTooltip = () => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setShouldRender(true);
      requestAnimationFrame(() => {
        calculatePosition();
        setIsVisible(true);
      });
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setIsVisible(false);
    hideTimeoutRef.current = setTimeout(() => setShouldRender(false), 150);
  };

  useEffect(() => {
    if (!shouldRender) return;

    const handleReposition = () => calculatePosition();
    window.addEventListener('scroll', handleReposition, true);
    window.addEventListener('resize', handleReposition);

    return () => {
      window.removeEventListener('scroll', handleReposition, true);
      window.removeEventListener('resize', handleReposition);
    };
  }, [shouldRender, calculatePosition]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    setActualPosition(position);
  }, [position]);

  if (disabled) {
    return <>{children}</>;
  }

  const tooltipContent = shouldRender && mounted ? (
    <div
      ref={tooltipRef}
      role="tooltip"
      className={`fixed z-[9999] pointer-events-none transition-all duration-150 ease-out ${
        isVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
      }`}
      style={{ top: coords.top, left: coords.left }}
    >
      <div className="relative px-2.5 py-1.5 text-xs font-medium text-zinc-700 bg-white rounded-md shadow-lg border border-zinc-200 whitespace-nowrap">
        {content}
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={triggerRef}
      className={`relative inline-flex ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      {mounted && tooltipContent && createPortal(tooltipContent, document.body)}
    </div>
  );
}
