import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

const API_URL = process.env.NEXT_PUBLIC_API_URL!

export async function GET() {
  try {
    const cookieStore = await cookies()
    const allCookies = cookieStore.getAll()
    const cookieHeader = allCookies.map((c) => `${c.name}=${c.value}`).join('; ')

    const response = await fetch(`${API_URL}/appraisal-presets`, {
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      credentials: 'include',
    })

    if (!response.ok) {
      return NextResponse.json({ presets: [] })
    }

    const data = (await response.json()) as {
      presets?: Array<{ id: string; name: string; isDefault: boolean }>
    }
    return NextResponse.json({
      presets: data.presets?.map((p) => ({
        id: p.id,
        name: p.name,
        isDefault: p.isDefault,
      })) || [],
    })
  } catch {
    return NextResponse.json({ presets: [] })
  }
}
