import { build, createServer } from 'vite';
import { rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import liveReload from '@magic-spells/vite-plugin-live-reload';

const isDev = process.env.NODE_ENV === 'development';
const outDir = isDev ? 'demo/dist' : 'dist';

function sharedBuild(overrides = {}) {
	return {
		configFile: false,
		logLevel: isDev ? 'warn' : 'info',
		css: { transformer: 'lightningcss' },
		build: {
			outDir,
			emptyOutDir: false,
			sourcemap: true,
			target: 'es2022',
			reportCompressedSize: !isDev,
			watch: isDev ? {} : null,
			...overrides.build,
		},
		...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'build')),
	};
}

function esmConfig({ emitCss = false } = {}) {
	return sharedBuild({
		build: {
			lib: {
				entry: 'src/index.js',
				fileName: () => 'split-panel.esm.js',
				formats: ['es'],
				...(emitCss ? { cssFileName: 'split-panel' } : {}),
			},
			minify: false,
			cssMinify: emitCss ? false : undefined,
			rolldownOptions: {
				output: { exports: 'named' },
			},
		},
	});
}

function umdMinConfig({ emitCss = false } = {}) {
	return sharedBuild({
		build: {
			lib: {
				entry: 'src/index.js',
				name: 'SplitPanel',
				fileName: () => 'split-panel.min.js',
				formats: ['umd'],
				...(emitCss ? { cssFileName: 'split-panel.min' } : {}),
			},
			minify: 'terser',
			terserOptions: {
				mangle: { keep_classnames: true, keep_fnames: false },
			},
			cssMinify: emitCss ? 'lightningcss' : undefined,
			rolldownOptions: {
				output: { exports: 'named' },
			},
		},
	});
}

// Unminified UMD — dev only. Demos can reference `/dist/split-panel.js` for
// readable stack traces without polluting the prod `dist/`.
function umdDevConfig() {
	return sharedBuild({
		build: {
			lib: {
				entry: 'src/index.js',
				name: 'SplitPanel',
				fileName: () => 'split-panel.js',
				formats: ['umd'],
			},
			minify: false,
			rolldownOptions: {
				output: { exports: 'named' },
			},
		},
	});
}

async function main() {
	if (!isDev) {
		// Clean prod output before building
		await rm(outDir, { recursive: true, force: true });
		await mkdir(outDir, { recursive: true });
	} else if (!existsSync(outDir)) {
		await mkdir(outDir, { recursive: true });
	}

	const configs = [esmConfig({ emitCss: true }), umdMinConfig({ emitCss: true })];
	if (isDev) configs.push(umdDevConfig());

	if (isDev) {
		// Fire all builds in parallel (watch mode — they don't block)
		for (const cfg of configs) {
			build(cfg).catch((e) => {
				console.error('build error:', e);
			});
		}

		// Start dev server serving demo/
		const server = await createServer({
			configFile: false,
			root: 'demo',
			server: { port: 3020, open: true, strictPort: false },
			plugins: [liveReload('demo/dist')],
		});
		await server.listen();
		server.printUrls();
	} else {
		// Sequential builds for prod (deterministic + smaller memory footprint)
		for (const cfg of configs) {
			await build(cfg);
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
