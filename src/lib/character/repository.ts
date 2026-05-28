import type { PrismaClient } from '@/generated/prisma/client'
import type { CreateCharacterInput } from '@/schemas/character.dto'

function serializeCharacter(input: CreateCharacterInput) {
  return {
    name: input.name,
    gender: input.gender,
    age: input.age,
    occupation: input.occupation,
    appearance: input.appearance,
    first_person: input.first_person,
    address_others: input.address_others,
    speech_examples: JSON.stringify(input.speech_examples),
    description: input.description
  }
}

export function parseCharacter<T extends { speech_examples: string }>(row: T) {
  let examples: string[] = []
  try {
    const parsed = JSON.parse(row.speech_examples)
    if (Array.isArray(parsed)) examples = parsed as string[]
  } catch {
    // malformed stored value — return empty array
  }
  return { ...row, speech_examples: examples }
}

export async function createCharacter(prisma: PrismaClient, input: CreateCharacterInput) {
  const row = await prisma.character.create({ data: serializeCharacter(input) })
  return parseCharacter(row)
}

export async function listCharacters(prisma: PrismaClient) {
  const rows = await prisma.character.findMany({ orderBy: { created_at: 'desc' } })
  return rows.map(parseCharacter)
}

export async function getCharacter(prisma: PrismaClient, id: string) {
  const row = await prisma.character.findUnique({ where: { id } })
  if (!row) return null
  return parseCharacter(row)
}

export async function updateCharacter(prisma: PrismaClient, id: string, input: CreateCharacterInput) {
  const row = await prisma.character.update({ where: { id }, data: serializeCharacter(input) })
  return parseCharacter(row)
}

export async function deleteCharacter(prisma: PrismaClient, id: string) {
  return prisma.character.delete({ where: { id } })
}
