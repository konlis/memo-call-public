import { z } from "zod";

export const analysisSchema = z.object({
	summary: z.string().max(2000),
	keyInsights: z.array(z.string()).min(0).max(20),
	decisions: z.array(z.string()).min(0).max(20),
	actionItems: z.array(z.string()).min(0).max(20),
	candidateTags: z.array(z.string()).min(0).max(10),
});

export const categorySchema = z.enum(["praca", "prywatne"]);

export const classificationSchema = z.object({
	category: categorySchema,
	projectId: z.string().min(1),
});

export type Analysis = z.infer<typeof analysisSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Classification = z.infer<typeof classificationSchema>;
