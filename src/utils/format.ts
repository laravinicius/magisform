// Remove acentos para comparação na busca (ex.: "jose" encontra "José")
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Padroniza a exibição da unidade sem alterar o valor persistido.
export function formatUnit(unit: string): string {
  const normalizedUnit = unit.toLowerCase();
  if (normalizedUnit === 'caps s.l.') return 'caps S.L.';
  if (normalizedUnit === 'sachê') return 'sachês';
  return unit;
}
