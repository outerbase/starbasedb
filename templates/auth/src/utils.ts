export function createJSONResponse(data: {
    result: any
    error: string | undefined
    status: number
}): Response {
    return new Response(
        JSON.stringify({
            result: data.result,
            error: data.error,
        }),
        {
            status: data.status,
            headers: {
                'Content-Type': 'application/json',
            },
        }
    )
}

export function createResponse(
    result: any,
    error: string | undefined,
    status: number
): Response {
    return createJSONResponse({
        result,
        error,
        status,
    })
}

export function verifyPassword(env: any, password: string): boolean {
    if (password.length < env.PASSWORD_REQUIRE_LENGTH) {
        return false
    }

    if (env.PASSWORD_REQUIRE_UPPERCASE && !/[A-Z]/.test(password)) {
        return false
    }

    if (env.PASSWORD_REQUIRE_LOWERCASE && !/[a-z]/.test(password)) {
        return false
    }

    if (env.PASSWORD_REQUIRE_NUMBER && !/[0-9]/.test(password)) {
        return false
    }

    if (
        env.PASSWORD_REQUIRE_SPECIAL &&
        !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)
    ) {
        return false
    }

    return true
}

export async function encryptPassword(password: string): Promise<string> {
    const encoder = new TextEncoder()
    const data = encoder.encode(password)
    const hash = await crypto.subtle.digest('SHA-256', data)
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
}

export async function decryptPassword(
    encryptedPassword: string
): Promise<string> {
    const decoder = new TextDecoder()
    const data = new Uint8Array(
        atob(encryptedPassword)
            .split('')
            .map((c) => c.charCodeAt(0))
    )
    const hash = await crypto.subtle.digest('SHA-256', data)
    return decoder.decode(hash)
}
