import React from 'react'

type DivProps = React.HTMLAttributes<HTMLDivElement>
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>
type InputProps = React.InputHTMLAttributes<HTMLInputElement>
type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>
type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

export function Page({ children }: DivProps) {
  return <div className="page">{children}</div>
}

export function TopNav({ children }: DivProps) {
  return <nav className="top-nav">{children}</nav>
}

export function NavButton({ children, ...props }: ButtonProps) {
  return <button className="nav-button" type="button" {...props}>{children}</button>
}

export function Card({ children, className = '', ...props }: DivProps) {
  return <section className={`card ${className}`.trim()} {...props}>{children}</section>
}

export function Row({ children, className = '', ...props }: DivProps) {
  return <div className={`row ${className}`.trim()} {...props}>{children}</div>
}

export function Label({ children }: { children: React.ReactNode }) {
  return <label className="label">{children}</label>
}

export function TextInput(props: InputProps) {
  return <input className="text-input" {...props} />
}

export function SelectInput(props: SelectProps) {
  return <select className="text-input" {...props} />
}

export function TextArea(props: TextareaProps) {
  return <textarea className="text-area" {...props} />
}

export function ActionButton({ children, ...props }: ButtonProps) {
  return <button className="action-button" type="button" {...props}>{children}</button>
}

