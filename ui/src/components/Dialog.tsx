import { useEffect, useRef, type ReactNode } from 'react'

export function Dialog({
  children,
  label,
  className = 'modal',
  onClose,
}: {
  children: ReactNode
  label: string
  className?: string
  onClose?: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const trigger = document.activeElement
    dialog.showModal()
    return () => {
      dialog.close()
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault()
        onClose?.()
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return
        const bounds = e.currentTarget.getBoundingClientRect()
        if (
          e.clientX < bounds.left ||
          e.clientX > bounds.right ||
          e.clientY < bounds.top ||
          e.clientY > bounds.bottom
        )
          onClose?.()
      }}
    >
      {children}
    </dialog>
  )
}
