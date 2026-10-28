"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";

// password-rules has ZERO server-only deps (zod only), so importing it into
// this client component does NOT pull bcryptjs into the bundle. Client + server
// validate against the exact same rule — no drift.
import {
	PASSWORD_RULE_HINT,
	PASSWORD_VALIDATION_SCHEMA,
} from "~/server/auth/password-rules";
import { api } from "~/trpc/react";

export function SetupForm() {
	const router = useRouter();
	const passwordId = useId();
	const confirmId = useId();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);

	const setInitialPassword = api.setup.setInitialPassword.useMutation({
		onSuccess: () => router.push("/login"),
		onError: (err) => setError(err.message),
	});

	function onSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setError(null);

		if (password !== confirm) {
			setError("Passwords do not match.");
			return;
		}
		const parsed = PASSWORD_VALIDATION_SCHEMA.safeParse(password);
		if (!parsed.success) {
			setError(parsed.error.issues[0]?.message ?? "Invalid password.");
			return;
		}

		setInitialPassword.mutate({ password });
	}

	const pending = setInitialPassword.isPending;

	return (
		<form className="flex w-full flex-col gap-4" onSubmit={onSubmit}>
			{error ? (
				<p
					className="rounded-md bg-red-500/15 px-3 py-2 text-red-200 text-sm"
					role="alert"
				>
					{error}
				</p>
			) : null}

			<div className="flex flex-col gap-2">
				<label
					className="font-medium text-sm text-white/80"
					htmlFor={passwordId}
				>
					Password
				</label>
				<input
					autoComplete="new-password"
					className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
					disabled={pending}
					id={passwordId}
					onChange={(e) => setPassword(e.target.value)}
					required
					type="password"
					value={password}
				/>
				<p className="text-white/50 text-xs">{PASSWORD_RULE_HINT}</p>
			</div>

			<div className="flex flex-col gap-2">
				<label
					className="font-medium text-sm text-white/80"
					htmlFor={confirmId}
				>
					Confirm password
				</label>
				<input
					autoComplete="new-password"
					className="rounded-md bg-white/10 px-3 py-2 text-white outline-none ring-1 ring-white/20 focus:ring-2 focus:ring-[#a855f7] disabled:opacity-50"
					disabled={pending}
					id={confirmId}
					onChange={(e) => setConfirm(e.target.value)}
					required
					type="password"
					value={confirm}
				/>
			</div>

			<button
				className="rounded-md bg-[#a855f7] px-4 py-2 font-semibold text-white transition hover:bg-[#9333ea] disabled:cursor-not-allowed disabled:opacity-50"
				disabled={pending}
				type="submit"
			>
				{pending ? "Setting password…" : "Set password"}
			</button>
		</form>
	);
}
