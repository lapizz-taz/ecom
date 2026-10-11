import { ThemeSections } from '@/features/storefront/sections'
import { resolveTheme, useStorefront } from '@/features/storefront/theme'
import { useStoreConfig } from '@/hooks/use-store-config'

/** The home page: the theme's sections in order (edited in the theme builder). */
export default function HomePage() {
  const { data: config } = useStoreConfig()
  const sf = useStorefront(config?.storefront)
  return <ThemeSections sections={resolveTheme(sf).sections} />
}
