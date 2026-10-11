import { createContext, useContext } from 'react'
import { DEFAULT_THEME, type StoreTheme } from './theme'

/** The resolved theme for the store being shown (set by the storefront layout). */
export const StoreThemeContext = createContext<StoreTheme>(DEFAULT_THEME)
export const useStoreTheme = () => useContext(StoreThemeContext)
