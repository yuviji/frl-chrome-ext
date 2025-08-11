import { describe, it, expect, beforeEach } from 'vitest'
import { buildSelector, textHintFor, roleHintFor } from './selector'

describe('selector builder', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('prefers ARIA role+name', () => {
    const btn = document.createElement('button')
    btn.textContent = 'Submit'
    document.body.appendChild(btn)
    const built = buildSelector(btn)
    expect(built.strategy).toBe('aria')
    expect(built.selector).toContain('role=button')
    expect(built.selector).toContain('name=Submit')
    expect(built.shadowChain).toEqual([])
    expect(built.frameChain).toEqual([])
  })

  it('uses data-testid/data-test/data-qa when present', () => {
    const div = document.createElement('div')
    div.setAttribute('data-testid', 'main')
    document.body.appendChild(div)
    const built = buildSelector(div)
    expect(built.strategy).toBe('data')
    expect(built.selector).toBe('[data-testid="main"]')
  })

  it('falls back to compact CSS with nth-of-type', () => {
    const ul = document.createElement('ul')
    for (let i = 0; i < 3; i++) {
      const li = document.createElement('li')
      ul.appendChild(li)
    }
    document.body.appendChild(ul)
    const target = ul.children[1] as Element
    const built = buildSelector(target)
    expect(built.strategy).toBe('css')
    expect(built.selector).toMatch(/li:nth-of-type\(2\)$/)
  })

  it('captures shadow DOM chain', () => {
    const host = document.createElement('div')
    host.id = 'host'
    const shadow = host.attachShadow({ mode: 'open' })
    const inner = document.createElement('span')
    inner.textContent = 'Hello'
    shadow.appendChild(inner)
    document.body.appendChild(host)

    const built = buildSelector(inner)
    expect(built.shadowChain.length).toBe(1)
    expect(built.shadowChain[0]).toContain('#host')
  })

  it('roleHintFor and textHintFor provide hints', () => {
    const input = document.createElement('input')
    input.type = 'text'
    input.setAttribute('aria-label', 'Search')
    document.body.appendChild(input)
    expect(roleHintFor(input)).toBe('textbox')
    expect(textHintFor(input)).toBe('Search')
  })
})


