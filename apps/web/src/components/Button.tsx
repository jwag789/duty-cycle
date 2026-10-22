import type { ButtonHTMLAttributes } from 'react';

/**
 * A button that doesn't take focus on click. The whole page is a keyboard
 * instrument, and a focused button would swallow Space and the note keys.
 */
export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={className ? `btn ${className}` : 'btn'}
      onMouseDown={(event) => event.preventDefault()}
      {...props}
    />
  );
}
