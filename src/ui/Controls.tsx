import * as React from 'react';

/** Adapted from shadcn/ui Input and Button primitives; see SOURCES.md. */
type ButtonProps = React.ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'text' | 'quiet';
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'primary', ...props }, ref) => (
    <button ref={ref} data-slot="button" data-variant={variant} className={`tc-${variant}-button ${className}`} {...props} />
  ),
);
Button.displayName = 'Button';

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className = '', type, ...props }, ref) => (
    <input ref={ref} type={type} data-slot="input" className={className} {...props} />
  ),
);
Input.displayName = 'Input';
