import type {ResearchConsistencyBinding, ResearchConsistencyCalculation} from '../../../shared/schemas/research-consistency';
import type {ResearchExperimentResultReceipt} from '../../../shared/schemas/research-experiment-results';

// Numeric locations use canonical decimal syntax, including scientific notation.
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
type Rational = {n: bigint; d: bigint};
export function consistencyNumericLocations(content: string): {start: number; end: number; text: string}[] {
  return [...content.matchAll(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/gu)]
    .map(token => ({start: token.index, end: token.index + token[0].length, text: token[0]}));
}
function decimal(text: string): Rational {
  const [coefficient, exponentText = '0'] = text.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const sign = coefficient.startsWith('-') ? -1n : 1n;
  const unsigned = coefficient.replace(/^[+-]/u, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = BigInt(`${whole || '0'}${fraction}`);
  const power = exponent - fraction.length;
  return power >= 0 ? {n: sign * digits * 10n ** BigInt(power), d: 1n} :
    {n: sign * digits, d: 10n ** BigInt(-power)};
}
function affine(value: Rational, scale: Rational, offset: Rational): Rational {
  return {n: value.n * scale.n * offset.d + offset.n * value.d * scale.d,
    d: value.d * scale.d * offset.d};
}
function rounded(value: Rational, places: number): string {
  const factor = 10n ** BigInt(places);
  const negative = value.n < 0n;
  const scaled = (negative ? -value.n : value.n) * factor;
  const integer = scaled / value.d + ((scaled % value.d) * 2n >= value.d ? 1n : 0n);
  const digits = integer.toString().padStart(places + 1, '0');
  const text = places === 0 ? digits : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return negative && integer !== 0n ? `-${text}` : text;
}
export function calculateConsistency(binding: ResearchConsistencyBinding, content: string,
  receipt: ResearchExperimentResultReceipt): ResearchConsistencyCalculation {
  const observedText = content.slice(binding.start, binding.end);
  if (binding.end > content.length || observedText.length > 128 || !numeric.test(observedText) ||
    !Number.isFinite(Number(observedText))) throw new Error('research_consistency_span_invalid');
  // The span must cover the whole numeric token, including sign/exponent.
  if (!consistencyNumericLocations(content).some(token => token.start === binding.start && token.end === binding.end)) {
    throw new Error('research_consistency_span_invalid');
  }
  return calculateConsistencyValue(binding, observedText, receipt);
}
export function calculateConsistencyValue(binding: Pick<ResearchConsistencyBinding, 'unit' | 'metricId' | 'rule'>,
  observedText: string, receipt: ResearchExperimentResultReceipt): ResearchConsistencyCalculation {
  if (observedText.length > 128 || !numeric.test(observedText) || !Number.isFinite(Number(observedText))) {
    throw new Error('research_consistency_span_invalid');
  }
  const metric = receipt.snapshot.result.metrics.find(item => item.id === binding.metricId);
  const definition = receipt.snapshot.request.definitions.find(item => item.id === binding.metricId);
  if (metric === undefined || definition === undefined || definition.unit !== metric.unit) {
    throw new Error('research_consistency_metric_invalid');
  }
  const conversion = binding.rule.conversion;
  if (conversion.kind === 'identity' ? binding.unit !== metric.unit :
    conversion.fromUnit !== metric.unit || conversion.toUnit !== binding.unit) {
    throw new Error('research_consistency_unit_mismatch');
  }
  const exact = conversion.kind === 'identity' ? decimal(String(metric.value)) :
    affine(decimal(String(metric.value)), decimal(String(conversion.scale)), decimal(String(conversion.offset)));
  const convertedValue = conversion.kind === 'identity' ? metric.value : metric.value * conversion.scale + conversion.offset;
  const expectedText = binding.rule.rounding.kind === 'none' ? String(convertedValue) :
    rounded(exact, binding.rule.rounding.places);
  const expectedValue = Number(expectedText), observed = Number(observedText);
  const difference = Math.abs(observed - expectedValue);
  const allowedDifference = Math.max(binding.rule.tolerance.absolute,
    binding.rule.tolerance.relative * Math.abs(expectedValue));
  if (![convertedValue, expectedValue, difference, allowedDifference].every(Number.isFinite)) {
    throw new Error('research_consistency_calculation_range');
  }
  return {observedText, observed, sourceValue: metric.value, sourceUnit: metric.unit,
    convertedValue, expectedValue, expectedText, difference, allowedDifference, consistent: difference <= allowedDifference};
}
