import { describe, it, expect, beforeEach } from 'vitest'
import { createRecorder } from './recorder'

function dispatchClick(target: Element) {
  const ev = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true })
  target.dispatchEvent(ev)
}

describe('recorder actions and predicates', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('records click followed by domAdded predicate', async () => {
    // Demo page with a button
    const btn = document.createElement('button')
    btn.textContent = 'Click Me'
    document.body.appendChild(btn)

    // Ensure we simulate a starting URL before starting the recorder
    history.replaceState({}, '', 'https://example.com/page')
    const recorder = createRecorder()
    recorder.start()
    dispatchClick(btn)

    // Cause DOM addition inside container (likely body)
    setTimeout(() => {
      const added = document.createElement('div')
      added.textContent = 'New node'
      document.body.appendChild(added)
    }, 10)

    await new Promise((r) => setTimeout(r, 250))
    recorder.stop()
    const dump = recorder.dump()

    expect(dump.steps.length).toBeGreaterThanOrEqual(2)
    expect(dump.meta.startUrl).toBe(globalThis.location.href)
    const last = dump.steps[dump.steps.length - 1]
    const prev = dump.steps[dump.steps.length - 2]
    expect(prev.kind).toBe('action')
    if (prev.kind === 'action') {
      expect(prev.action.name).toBe('click')
      // include hints in selector
      expect(prev.selector).toHaveProperty('textHint')
      expect(prev.selector).toHaveProperty('roleHint')
    }
    expect(last.kind).toBe('waitForPredicate')
    if (last.kind === 'waitForPredicate') {
      expect(['domAdded', 'textChanged']).toContain(last.predicate)
    }
  })

  it('records ariaLiveUpdated when live region text changes', async () => {
    const container = document.createElement('div')
    const btn = document.createElement('button')
    btn.textContent = 'Notify'
    const live = document.createElement('div')
    live.id = 'status'
    live.setAttribute('aria-live', 'polite')
    container.appendChild(btn)
    container.appendChild(live)
    document.body.appendChild(container)

    const recorder = createRecorder()
    recorder.start()
    dispatchClick(btn)

    setTimeout(() => {
      live.textContent = 'Loaded'
    }, 10)

    await new Promise((r) => setTimeout(r, 250))
    recorder.stop()
    const dump = recorder.dump()

    const last = dump.steps[dump.steps.length - 1]
    expect(last.kind).toBe('waitForPredicate')
    if (last.kind === 'waitForPredicate') {
      expect(last.predicate).toBe('ariaLiveUpdated')
    }
  })

  it('redacts password typing and flags step as redacted', async () => {
    const form = document.createElement('form')
    const lbl = document.createElement('label')
    lbl.setAttribute('for', 'pwd')
    lbl.textContent = 'Password'
    const pwd = document.createElement('input')
    pwd.type = 'password'
    pwd.id = 'pwd'
    form.appendChild(lbl)
    form.appendChild(pwd)
    document.body.appendChild(form)

    const recorder = createRecorder()
    recorder.start()
    // Simulate user typing one character; our recorder listens to input event data
    const inputEv = new InputEvent('input', { bubbles: true, composed: true, data: 's' })
    pwd.dispatchEvent(inputEv)

    await new Promise((r) => setTimeout(r, 10))
    recorder.stop()
    const dump = recorder.dump()

    const typeSteps = dump.steps.filter((s: any) => s.kind === 'action' && s.action?.name === 'type') as any[]
    expect(typeSteps.length).toBeGreaterThanOrEqual(1)
    const lastType = typeSteps[typeSteps.length - 1]
    expect(lastType.action.text).toBe('***')
    expect(lastType.redacted).toBe(true)
  })
})



