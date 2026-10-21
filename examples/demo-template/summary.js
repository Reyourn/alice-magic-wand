export function summarize(values) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError('Expected an array of finite numbers');
  const total = values.reduce((sum, value) => sum + value, 0);
  return { count: values.length, total, average: total / values.length };
}
