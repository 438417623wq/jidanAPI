import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// 按 shadcn 的源码维护方式组合基础组件，只引入本阶段需要的原语。
export const cn = (...values: ClassValue[]) => twMerge(clsx(values))

export function Button({ className, variant = 'default', asChild = false, ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost'; asChild?: boolean }) {
  const Component = asChild ? Slot : 'button'
  return <Component type="button" className={cn('ui-button', `ui-button-${variant}`, className)} {...props} />
}
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ui-card', className)} {...props} />
}
export function Badge({ className, tone = 'neutral', ...props }:
  React.HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'success' | 'warning' | 'blue' }) {
  return <span className={cn('ui-badge', `ui-badge-${tone}`, className)} {...props} />
}
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('ui-input', className)} {...props} />
}
