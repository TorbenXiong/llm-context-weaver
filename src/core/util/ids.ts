export const newId = (): string => crypto.randomUUID();
export const shortId = (id: string): string => id.replace(/-/g, '').slice(0, 8);