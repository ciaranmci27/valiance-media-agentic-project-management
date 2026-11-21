'use client';

import { createContext, useContext } from 'react';
import { DEFAULT_BRAND } from './defaults';
import type { Brand } from './types';

/**
 * The brand in the browser. The root layout reads it on the server
 * (getBrand) and hands it down, so every client component reads the same
 * brand the page was rendered with, with no request of its own.
 */
const BrandContext = createContext<Brand>(DEFAULT_BRAND);

export function BrandProvider({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  return useContext(BrandContext);
}
