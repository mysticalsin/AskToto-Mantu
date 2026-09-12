import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('MQA-303 does not restore vulnerable networking libraries bundled in the old Dust client', () => {
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'))
  expect(lock.packages['node_modules/@dust-tt/client'].version).not.toBe('1.2.6')
  expect(lock.packages['node_modules/@dust-tt/client/node_modules/express-rate-limit']).toBeUndefined()
  expect(lock.packages['node_modules/@dust-tt/client/node_modules/ip-address']).toBeUndefined()
})
