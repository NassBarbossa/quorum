import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { RpcClient } from '../../src/lib/rpc.js'

describe('RpcClient', () => {
  it('retries on 429 and eventually succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 42 } }),
      })
    const client = new RpcClient('https://rpc.example', { fetchImpl: fetchMock as never, baseDelayMs: 1, minIntervalMs: 0 })
    const schema = z.object({ value: z.number() })
    const out = await client.call('getThing', [], schema)
    expect(out).toEqual({ value: 42 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries on a network error (fetch rejects) and eventually succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 42 } }),
      })
    const client = new RpcClient('https://rpc.example', { fetchImpl: fetchMock as never, baseDelayMs: 1, minIntervalMs: 0 })
    const schema = z.object({ value: z.number() })
    const out = await client.call('getThing', [], schema)
    expect(out).toEqual({ value: 42 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws when the response fails schema validation instead of returning a default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 'not a number' } }),
    })
    const client = new RpcClient('https://rpc.example', { fetchImpl: fetchMock as never, baseDelayMs: 1, minIntervalMs: 0 })
    await expect(client.call('getThing', [], z.object({ value: z.number() }))).rejects.toThrow(/schema/i)
  })

  it('surfaces a JSON-RPC error rather than swallowing it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } }),
    })
    const client = new RpcClient('https://rpc.example', { fetchImpl: fetchMock as never, baseDelayMs: 1, minIntervalMs: 0 })
    await expect(client.call('getThing', [], z.unknown())).rejects.toThrow(/bad params/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('callHistorical appends the configured historical parameter, not minContextSlot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    })
    const client = new RpcClient('https://rpc.example', { fetchImpl: fetchMock as never, baseDelayMs: 1, minIntervalMs: 0 })
    await client.callHistorical('getAccountInfo', ['MINT'], 12345, z.object({ ok: z.boolean() }))
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)
    expect(sent.params).toEqual(['MINT', { encoding: 'jsonParsed', slot: 12345 }])
    expect(JSON.stringify(sent)).not.toMatch(/minContextSlot/)
  })

  it('callHistorical honours a provider-specific parameter shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    })
    const client = new RpcClient('https://rpc.example', {
      fetchImpl: fetchMock as never, baseDelayMs: 1, minIntervalMs: 0,
      historicalParam: slot => ({ encoding: 'jsonParsed', blockNumber: slot }),
    })
    await client.callHistorical('getAccountInfo', ['MINT'], 777, z.object({ ok: z.boolean() }))
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)
    expect(sent.params[1]).toEqual({ encoding: 'jsonParsed', blockNumber: 777 })
  })
})
