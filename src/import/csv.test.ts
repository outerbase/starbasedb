import { describe, it, expect, vi, beforeEach } from "vitest"
import { importTableFromCsvRoute } from "./csv"
import { executeOperation } from "../export"
import type { DataSource } from "../types"
import type { StarbaseDBConfiguration } from "../handler"

vi.mock("../export", () => ({
    executeOperation: vi.fn().mockResolvedValue(undefined),
}))

const mockDataSource = {
    source: "internal",
    rpc: { executeQuery: vi.fn() },
} as unknown as DataSource

const mockConfig: StarbaseDBConfiguration = {
    role: "admin",
}

// Executes importTableFromCsvRoute and extracts status and decoded JSON body.
async function runCsvImport(request: Request) {
    const response = await importTableFromCsvRoute(
        "users",
        request,
        mockDataSource,
        mockConfig
    )
    const body = (await response.json()) as Record<string, any>
    return { status: response.status, body }
}

describe("importTableFromCsvRoute validation and formats", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("rejects empty bodies, unsupported Content-Type, and header-only CSV inputs with 400", async () => {
        const emptyBodyRes = await runCsvImport(
            new Request("https://example.com/import/csv/users", {
                method: "POST",
            })
        )
        expect(emptyBodyRes.status).toBe(400)
        expect(emptyBodyRes.body.error).toBe("Request body is empty")

        const badTypeRes = await runCsvImport(
            new Request("https://example.com/import/csv/users", {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: "id,name\n1,Alice",
            })
        )
        expect(badTypeRes.status).toBe(400)
        expect(badTypeRes.body.error).toBe("Unsupported Content-Type")

        const headerOnlyRes = await runCsvImport(
            new Request("https://example.com/import/csv/users", {
                method: "POST",
                headers: { "Content-Type": "text/csv" },
                body: "id,name",
            })
        )
        expect(headerOnlyRes.status).toBe(400)
        expect(headerOnlyRes.body.error).toBe(
            "Invalid CSV format or empty data"
        )
    })

    it("imports JSON-wrapped CSV with columnMapping and raw text/csv with failed row tracking", async () => {
        const jsonReq = new Request("https://example.com/import/csv/users", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                data: "user_id,full_name\n1,Alice\n2,Bob",
                columnMapping: { user_id: "id", full_name: "name" },
            }),
        })
        const jsonRes = await runCsvImport(jsonReq)
        expect(jsonRes.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: "INSERT INTO users (id, name) VALUES (?, ?)",
                    params: ["1", "Alice"],
                },
            ],
            mockDataSource,
            mockConfig
        )

        vi.mocked(executeOperation)
            .mockResolvedValueOnce(undefined as any)
            .mockRejectedValueOnce(new Error("UNIQUE constraint failed"))

        const csvReq = new Request("https://example.com/import/csv/users", {
            method: "POST",
            headers: { "Content-Type": "text/csv" },
            body: "id,name\n1,Alice\n1,Duplicate",
        })
        const csvRes = await runCsvImport(csvReq)
        expect(csvRes.status).toBe(200)
        expect(csvRes.body.result.failedStatements).toHaveLength(1)
    })

    it("handles multipart/form-data file uploads and unexpected parsing errors", async () => {
        const emptyForm = new FormData()
        const missingFileRes = await runCsvImport(
            new Request("https://example.com/import/csv/users", {
                method: "POST",
                body: emptyForm,
            })
        )
        expect(missingFileRes.status).toBe(400)

        const uploadForm = new FormData()
        uploadForm.append(
            "file",
            new File(["id,name\n7,Charlie"], "users.csv", { type: "text/csv" })
        )
        const uploadRes = await runCsvImport(
            new Request("https://example.com/import/csv/users", {
                method: "POST",
                body: uploadForm,
            })
        )
        expect(uploadRes.status).toBe(200)
    })
})
