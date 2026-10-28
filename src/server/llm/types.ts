import type { ZodSchema } from "zod";

export interface LlmProvider {
	generateStructured<T>(input: {
		prompt: string;
		schema: ZodSchema<T>;
	}): Promise<T>;
}
