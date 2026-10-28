import { llm } from "~/server/llm";
import {
	type Category,
	type Classification,
	classificationSchema,
} from "~/server/llm/schemas";
import type { LlmProvider } from "~/server/llm/types";

export type Project = { id: string; name: string; category: Category };

export type ClassifyInput = {
	transcript: string;
	projects: ReadonlyArray<Project>;
};

export type ClassifyResult =
	| { status: "classified"; classification: Classification }
	| { status: "no_auto_assignment"; attempts: number };

export type ClassifyOptions = { provider?: LlmProvider };

const MAX_ATTEMPTS = 3;

function buildClassifyPrompt(input: ClassifyInput, feedback?: string): string {
	const projectsList = input.projects
		.map((p) => `  - id="${p.id}" name="${p.name}" category="${p.category}"`)
		.join("\n");

	const lines = [
		"Jesteś asystentem klasyfikującym polskie rozmowy biznesowe.",
		"Wybierz kategorię (praca | prywatne) i projekt, do którego pasuje rozmowa.",
		"Projekt MUSI należeć do tej samej kategorii co wybór kategorii.",
		"Dostępne projekty:",
		projectsList,
		"",
		"Transkrypt:",
		input.transcript,
	];

	if (feedback) {
		lines.push("", "Poprzednia próba była niepoprawna:", feedback);
	}

	return lines.join("\n");
}

function describeViolation(
	classification: Classification,
	input: ClassifyInput,
): string {
	const project = input.projects.find((p) => p.id === classification.projectId);
	if (!project) {
		return `Wybrałeś projectId="${classification.projectId}", który nie istnieje na liście projektów. Wybierz projectId z dostępnej listy.`;
	}
	return `Wybrałeś category="${classification.category}" z projectId="${classification.projectId}", ale projekt "${project.id}" należy do kategorii "${project.category}". Wybierz projekt z kategorii "${classification.category}" lub zmień kategorię na "${project.category}".`;
}

function isValid(
	classification: Classification,
	input: ClassifyInput,
): boolean {
	const project = input.projects.find((p) => p.id === classification.projectId);
	return project !== undefined && project.category === classification.category;
}

export async function classify(
	input: ClassifyInput,
	opts: ClassifyOptions = {},
): Promise<ClassifyResult> {
	const provider = opts.provider ?? llm;
	let feedback: string | undefined;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const prompt = buildClassifyPrompt(input, feedback);
		const classification = await provider.generateStructured({
			prompt,
			schema: classificationSchema,
		});

		if (isValid(classification, input)) {
			return { status: "classified", classification };
		}

		feedback = describeViolation(classification, input);
	}

	return { status: "no_auto_assignment", attempts: MAX_ATTEMPTS };
}
