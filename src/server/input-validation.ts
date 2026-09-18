export function validateTextField(value: unknown, field: string, maxLength: number, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    return required ? `${field} ist erforderlich.` : null;
  }
  if (typeof value !== 'string') return `${field} muss Text sein.`;
  if (value.length > maxLength) return `${field} darf maximal ${maxLength} Zeichen enthalten.`;
  return null;
}
