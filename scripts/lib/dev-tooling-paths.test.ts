import { describe, it, expect } from 'vitest'
import { findDevTooling, ALLOWED_PATHS } from './dev-tooling-paths.mjs'

describe('findDevTooling (ADR-025)', () => {
  it('flags graphify, code-review-graph and bundled Python paths', () => {
    const hits = findDevTooling([
      'Metis.app/Contents/Resources/graphify/cli.py',
      'resources/code-review-graph/server.js',
      'resources/code_review_graph/__init__.py',
      'resources/python/python.exe',
      'resources/python3.11',
      'resources/python311.dll',
      'Metis.app/Contents/Resources/runtime/Python.framework/Versions/3.11/Python',
      'resources/venv/lib/site-packages/requests/api.py',
      'resources/libpython3.11.dylib'
    ])
    expect(hits.map((h) => h.reason)).toEqual([
      'graphify',
      'code-review-graph',
      'code-review-graph',
      'bundled Python',
      'bundled Python',
      'bundled Python',
      'bundled Python',
      'bundled Python',
      'bundled Python'
    ])
  })

  it('allows only the graphify runner script, on either platform layout', () => {
    expect(ALLOWED_PATHS).toEqual(['resources/graphify_runner.py'])
    expect(findDevTooling(['resources/graphify_runner.py'])).toEqual([])
    expect(findDevTooling(['Metis.app/Contents/Resources/graphify_runner.py'])).toEqual([])
    expect(findDevTooling(['resources\\graphify_runner.py'])).toEqual([])
    expect(findDevTooling(['resources/graphify_runner.py.bak'])).toHaveLength(1)
  })

  it('passes a clean package listing', () => {
    expect(
      findDevTooling([
        'Metis.exe',
        'resources/app.asar',
        'resources/asr/model/tokens.txt',
        'Metis.app/Contents/MacOS/Metis'
      ])
    ).toEqual([])
  })
})
