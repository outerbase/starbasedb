import { beforeEach, expect, it, vi } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import { executeOperation } from '../export'
vi.mock('../export', () => ({ executeOperation: vi.fn() }))
const run = (request: Request) =>
    importTableFromCsvRoute('users', request, {} as any, {} as any)
const req = (body: string, type = 'text/csv') =>
    new Request('https://test/import', {
        method: 'POST',
        headers: { 'Content-Type': type },
        body,
    })
beforeEach(() => {
    vi.mocked(executeOperation).mockReset().mockResolvedValue([])
})
it('rejects a missing body', async () => {
    expect((await run(new Request('https://test'))).status).toBe(400)
    expect(executeOperation).not.toHaveBeenCalled()
})
it.each(['text/plain', ''])(
    'rejects unsupported content type %s',
    async (type) => {
        expect((await run(req('id\n1', type))).status).toBe(400)
        expect(executeOperation).not.toHaveBeenCalled()
    }
)
it('maps JSON-wrapped CSV columns and parameterizes values', async () => {
    const response = await run(
        req(
            JSON.stringify({
                data: ' name , age\n Alice , 20',
                columnMapping: { name: 'full_name' },
            }),
            'application/json'
        )
    )
    expect(response.status).toBe(200)
    expect(executeOperation).toHaveBeenCalledWith(
        [
            {
                sql: 'INSERT INTO users (full_name, age) VALUES (?, ?)',
                params: ['Alice', '20'],
            },
        ],
        {},
        {}
    )
})
it('imports raw CSV and ignores rows with mismatched field counts', async () => {
    expect((await run(req('id,name\n1,Alice\ninvalid'))).status).toBe(200)
    expect(executeOperation).toHaveBeenCalledTimes(1)
})
it('rejects headers without records', async () => {
    expect((await run(req('id,name'))).status).toBe(400)
    expect(executeOperation).not.toHaveBeenCalled()
})
it('requires a multipart file', async () => {
    const form = new FormData()
    form.set('other', 'x')
    expect(
        (await run(new Request('https://test', { method: 'POST', body: form })))
            .status
    ).toBe(400)
})
it('imports an uploaded file', async () => {
    const form = new FormData()
    form.set(
        'file',
        new Blob(['id,name\n1,Alice'], { type: 'text/csv' }),
        'users.csv'
    )
    expect(
        (await run(new Request('https://test', { method: 'POST', body: form })))
            .status
    ).toBe(200)
    expect(executeOperation).toHaveBeenCalledOnce()
})
it.each([new Error('write failed'), {}])(
    'reports partial failures: %j',
    async (error) => {
        vi.mocked(executeOperation)
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce([])
        const response = await run(req('id\n1\n2'))
        const body = (await response.json()) as any
        expect(response.status).toBe(200)
        expect(JSON.stringify(body)).toContain('Imported 1 out of 2')
        expect(JSON.stringify(body)).toContain('1 records failed')
    }
)
it('reports malformed JSON', async () => {
    expect((await run(req('{', 'application/json'))).status).toBe(500)
    expect(executeOperation).not.toHaveBeenCalled()
})
