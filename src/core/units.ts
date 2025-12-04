export type Unit = 'mm' | 'cm' | 'm' | 'in';

export const unitFactors: Record<Unit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254
};

export function convert(value: number, from: Unit, to: Unit): number {
  return (value * unitFactors[from]) / unitFactors[to];
}

export function format(value: number, unit: Unit, digits = 2): string {
  return `${value.toFixed(digits)} ${unit}`;
}
