import { cn } from '@/lib/utils'

// Logos of the platforms Fullfilio connects to, drawn as simple marks so they
// stay sharp at any size. Used only to show which store a connection is for.

/** Shopify: the green shopping bag. */
export function ShopifyLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 36" className={cn('size-5', className)} role="img" aria-label="Shopify">
      <path d="M26.4 7.3c0-.2-.2-.3-.3-.3l-3.2-.2-2.4-2.4c-.2-.2-.7-.2-.9-.1l-1.2.4C17.7 3 16.7 1.6 15 1.6h-.2C14.3 1 13.7.7 13.2.7 9.3.7 7.4 5.6 6.8 8.1l-2.7.8c-.8.3-.9.3-1 1.1L1 27.4l17.4 3.3 9.4-2-1.4-21.4Z" fill="#95BF47" />
      <path d="m26.1 7-3.2-.2-2.4-2.4c-.1-.1-.2-.1-.3-.1l-1.3 26.4 9.4-2L26.4 7.3c0-.2-.2-.3-.3-.3Z" fill="#5E8E3E" />
      <path d="m16.4 12.5-1.2 3.4s-1-.5-2.3-.5c-1.8 0-1.9 1.1-1.9 1.4 0 1.6 4 2.2 4 5.8 0 2.9-1.8 4.7-4.3 4.7-3 0-4.5-1.9-4.5-1.9l.8-2.6s1.6 1.4 2.9 1.4c.9 0 1.2-.7 1.2-1.2 0-2-3.3-2.1-3.3-5.4 0-2.8 2-5.5 6-5.5 1.6 0 2.6.4 2.6.4Z" fill="#fff" />
    </svg>
  )
}

/** WooCommerce: the purple "Woo" speech bubble. */
export function WooLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 26" className={cn('h-4 w-6', className)} role="img" aria-label="WooCommerce">
      <path d="M4.2 1h31.6A3.2 3.2 0 0 1 39 4.2v13.4a3.2 3.2 0 0 1-3.2 3.2H24.5l1.6 4.2-7-4.2H4.2A3.2 3.2 0 0 1 1 17.6V4.2A3.2 3.2 0 0 1 4.2 1Z" fill="#7F54B3" />
      <text x="20" y="14.6" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontSize="9.5" fontWeight="700" fill="#fff" letterSpacing="-.3">Woo</text>
    </svg>
  )
}

/** The logo for a store connection's platform. */
export function PlatformLogo({ platform, className }: { platform: 'SHOPIFY' | 'WOOCOMMERCE'; className?: string }) {
  return platform === 'SHOPIFY' ? <ShopifyLogo className={className} /> : <WooLogo className={className} />
}
