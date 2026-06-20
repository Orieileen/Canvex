import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** `useState` reset helper: returns `prev` unchanged when it's already empty,
 *  else a fresh `[]`. The same-ref return triggers React's setState bailout,
 *  skipping a re-render when the consumer was already cleared (common path
 *  for "clear on event" reset patterns). */
export function clearIfNonEmpty<T>(prev: T[]): T[] {
  return prev.length === 0 ? prev : []
}
