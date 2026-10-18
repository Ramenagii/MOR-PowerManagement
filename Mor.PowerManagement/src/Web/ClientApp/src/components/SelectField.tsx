import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'

type OptionProps = {
  value?: string
  disabled?: boolean
  children?: ReactNode
}

type MenuPosition = { top: number; left: number; width: number }

type SelectFieldProps = {
  children: ReactNode
  value: string
  onValueChange: (value: string) => void
  wrapperClassName?: string
  compact?: boolean
  disabled?: boolean
  'aria-label'?: string
}

/** Shared accessible dropdown for the light MOR Power interface. */
export function SelectField({
  children,
  value,
  onValueChange,
  wrapperClassName = '',
  compact = false,
  disabled = false,
  'aria-label': ariaLabel,
}: SelectFieldProps) {
  const menuId = useId()
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)

  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const option = child as ReactElement<OptionProps>
      return {
        value: option.props.value ?? '',
        label: option.props.children,
        disabled: option.props.disabled ?? false,
      }
    })
  const selectedOption = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!wrapperRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const menuHeight = Math.min(options.length * 38 + 8, 280)
      const width = Math.min(Math.max(rect.width, 160), window.innerWidth - 16)
      const openAbove = rect.bottom + menuHeight + 8 > window.innerHeight && rect.top > menuHeight
      setMenuPosition({
        top: openAbove ? Math.max(8, rect.top - menuHeight - 4) : rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, options.length])

  const findEnabled = (start: number, direction: 1 | -1) => {
    for (let step = 0; step < options.length; step += 1) {
      const index = (start + step * direction + options.length) % options.length
      if (!options[index]?.disabled) return index
    }
    return -1
  }

  const openMenu = (direction: 1 | -1 = 1) => {
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
    const start = selectedIndex >= 0 ? selectedIndex : (direction === 1 ? -1 : 0)
    setActiveIndex(findEnabled(start + direction, direction))
    setOpen(true)
  }

  const chooseOption = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onValueChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        openMenu(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((current) => findEnabled(current + direction, direction))
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault()
      chooseOption(activeIndex)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'Home' && open) {
      event.preventDefault()
      setActiveIndex(findEnabled(0, 1))
    } else if (event.key === 'End' && open) {
      event.preventDefault()
      setActiveIndex(findEnabled(options.length - 1, -1))
    } else if (event.key === 'Tab' && open) {
      setOpen(false)
    } else if ((event.key === 'Enter' || event.key === ' ') && !open) {
      event.preventDefault()
      openMenu()
    }
  }

  return (
    <span ref={wrapperRef} className={`mp-select-wrap ${compact ? 'mp-select-wrap-compact' : ''} ${wrapperClassName}`}>
      <button
        ref={triggerRef}
        type="button"
        className="mp-select-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? `${menuId}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span className="mp-select-value">{selectedOption?.label}</span>
        <ChevronDown className={`mp-select-chevron ${open ? 'is-open' : ''}`} size={16} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          className="mp-select-menu"
          id={menuId}
          role="listbox"
          aria-label={ariaLabel}
          style={{ top: menuPosition.top, left: menuPosition.left, width: menuPosition.width }}
        >
          {options.map((option, index) => (
            <div
              key={`${option.value}-${index}`}
              id={`${menuId}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={`mp-select-option ${index === activeIndex ? 'is-active' : ''} ${option.value === value ? 'is-selected' : ''} ${option.disabled ? 'is-disabled' : ''}`}
              onMouseEnter={() => !option.disabled && setActiveIndex(index)}
              onClick={() => chooseOption(index)}
            >
              <span>{option.label}</span>
              {option.value === value && <span className="mp-select-check" aria-hidden="true">✓</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )
}
