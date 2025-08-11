import { describe, it, expect } from 'vitest'
import { isDomainAllowed } from './settings'

describe('allowlist domain matching', () => {
  it('matches exact domain', () => {
    expect(isDomainAllowed('example.com', ['example.com'])).toBe(true)
  })

  it('matches subdomains', () => {
    expect(isDomainAllowed('sub.example.com', ['example.com'])).toBe(true)
  })

  it('normalizes dots and schemes', () => {
    expect(isDomainAllowed('foo.bar', ['https://bar'])).toBe(true)
    expect(isDomainAllowed('a.b.c', ['.b.c'])).toBe(true)
  })

  it('rejects non-matching domains', () => {
    expect(isDomainAllowed('other.com', ['example.com'])).toBe(false)
  })
})


