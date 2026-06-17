import type {
  StyleConditionDescriptor,
  StyleConditionInput,
  StyleShowInput,
} from "./style-appearance-types";

const DEFAULT_FEATURE_ID_ATTRIBUTE = 0;

export function normalizeFeatureIdAttribute(
  featureIdAttribute?: number,
): number {
  return featureIdAttribute ?? DEFAULT_FEATURE_ID_ATTRIBUTE;
}

export function resolveStyleConditionContent(
  input: StyleConditionInput,
): string | boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") return input;
  return input.content;
}

export function resolveStyleConditionFeatureIdAttribute(
  input: StyleConditionInput,
): number {
  if (typeof input === "object" && input !== null && "content" in input) {
    return normalizeFeatureIdAttribute(input.featureIdAttribute);
  }
  return DEFAULT_FEATURE_ID_ATTRIBUTE;
}

export function resolveShowContent(show?: StyleShowInput): string | undefined {
  if (show == null) return undefined;
  if (typeof show === "string") return show;
  return show.content;
}

export function resolveShowFeatureIdAttribute(show?: StyleShowInput): number {
  if (show == null) return DEFAULT_FEATURE_ID_ATTRIBUTE;
  if (typeof show === "string") return DEFAULT_FEATURE_ID_ATTRIBUTE;
  return normalizeFeatureIdAttribute(show.featureIdAttribute);
}

export function isStyleConditionDescriptor(
  value: unknown,
): value is StyleConditionDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof (value as StyleConditionDescriptor).content === "string"
  );
}

/** 从 style / highlight 配置中收集用到的 featureIdAttribute（去重、升序） */
export function collectFeatureIdAttributesFromStyleConfig(config: {
  show?: StyleShowInput;
  conditions?: readonly [StyleConditionInput, unknown][];
}): number[] {
  const attrs = new Set<number>();
  if (config.show != null) {
    attrs.add(resolveShowFeatureIdAttribute(config.show));
  }
  for (const [cond] of config.conditions ?? []) {
    attrs.add(resolveStyleConditionFeatureIdAttribute(cond));
  }
  if (attrs.size === 0) attrs.add(DEFAULT_FEATURE_ID_ATTRIBUTE);
  return [...attrs].sort((a, b) => a - b);
}
