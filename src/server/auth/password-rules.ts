import { z } from "zod";

export const PASSWORD_VALIDATION_SCHEMA = z
	.string()
	.refine((p) => p.length >= 12 || p.split(/\s+/).filter(Boolean).length >= 4, {
		message:
			"Password must be at least 12 characters OR at least 4 words separated by spaces.",
	});

export const PASSWORD_RULE_HINT =
	"At least 12 characters OR at least 4 words separated by spaces. Use a passphrase like correct horse battery staple for easier mobile typing.";
