import { Toaster as Sonner } from 'sonner'

/** Where the app's notifications appear (each one is drawn by src/lib/toast.tsx). */
function Toaster({ position = 'top-right' }: { position?: 'top-right' | 'top-center' | 'bottom-right' | 'bottom-center' }) {
  return (
    <Sonner position={position} visibleToasts={4} offset="4.25rem" mobileOffset={{ top: '4rem', left: '1rem', right: '1rem' }}
      gap={10} toastOptions={{ unstyled: true }} />
  )
}

export { Toaster }
