/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import * as network from 'vs/base/common/network';
import { basename } from 'vs/base/common/path';
import { isEqual, joinPath, toLocalResource } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import 'vs/css!./media/searchEditor';
import type { ICodeEditorViewState } from 'vs/editor/common/editorCommon';
import { IModelDeltaDecoration, ITextBufferFactory } from 'vs/editor/common/model';
import { IModelService } from 'vs/editor/common/services/modelService';
import { localize } from 'vs/nls';
import { IFileDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { EditorInput, GroupIdentifier, IEditorInput, IRevertOptions, ISaveOptions } from 'vs/workbench/common/editor';
import { SearchEditorScheme, SearchConfiguration } from 'vs/workbench/contrib/searchEditor/browser/constants';
import { SearchEditorModel } from 'vs/workbench/contrib/searchEditor/browser/searchEditorModel';
import { extractSearchQuery, serializeSearchConfiguration } from 'vs/workbench/contrib/searchEditor/browser/searchEditorSerialization';
import { IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { AutoSaveMode, IFilesConfigurationService } from 'vs/workbench/services/filesConfiguration/common/filesConfigurationService';
import { ITextFileSaveOptions, ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IWorkingCopy, IWorkingCopyBackup, IWorkingCopyService, WorkingCopyCapabilities } from 'vs/workbench/services/workingCopy/common/workingCopyService';

type SearchEditorViewState =
	| { focused: 'input' }
	| { focused: 'editor', state: ICodeEditorViewState };

export class SearchEditorInput extends EditorInput {
	static readonly ID: string = 'workbench.editorinputs.searchEditorInput';

	private dirty: boolean = false;
	private readonly model: Promise<SearchEditorModel>;
	private query: Partial<SearchConfiguration> | undefined;

	private readonly _onDidChangeContent = new Emitter<void>();
	readonly onDidChangeContent: Event<void> = this._onDidChangeContent.event;

	viewState: SearchEditorViewState = { focused: 'input' };

	private _highlights: IModelDeltaDecoration[] | undefined;

	constructor(
		public readonly resource: URI,
		getModel: () => Promise<SearchEditorModel>,
		startingConfig: Partial<SearchConfiguration> | undefined,
		@IModelService private readonly modelService: IModelService,
		@IEditorService protected readonly editorService: IEditorService,
		@IEditorGroupsService protected readonly editorGroupService: IEditorGroupsService,
		@ITextFileService protected readonly textFileService: ITextFileService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@IFilesConfigurationService private readonly filesConfigurationService: IFilesConfigurationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();

		this.model = getModel()
			.then(model => {
				this._register(model.resultsTextModel.onDidChangeContent(() => this._onDidChangeContent.fire()));
				this._register(model);
				return model;
			});

		const input = this;
		const workingCopyAdapter = new class implements IWorkingCopy {
			readonly resource = input.getResource();
			get name() { return input.getName(); }
			readonly capabilities = input.isUntitled() ? WorkingCopyCapabilities.Untitled : 0;
			readonly onDidChangeDirty = input.onDidChangeDirty;
			readonly onDidChangeContent = input.onDidChangeContent;
			isDirty(): boolean { return input.isDirty(); }
			backup(): Promise<IWorkingCopyBackup> { return input.backup(); }
			save(options?: ISaveOptions): Promise<boolean> { return input.save(0, options).then(editor => !!editor); }
			revert(options?: IRevertOptions): Promise<boolean> { return input.revert(0, options); }
		};

		this.workingCopyService.registerWorkingCopy(workingCopyAdapter);

		this.query = startingConfig;
	}

	getResource() {
		return this.resource;
	}

	async save(group: GroupIdentifier, options?: ITextFileSaveOptions): Promise<IEditorInput | undefined> {
		if ((await this.model).isDisposed()) { return; }

		if (this.isUntitled()) {
			return this.saveAs(group, options);
		} else {
			await this.textFileService.write(this.resource, (await this.model).createSnapshot(), options);
			this.setDirty(false);
			return this;
		}
	}

	async saveAs(group: GroupIdentifier, options?: ITextFileSaveOptions): Promise<IEditorInput | undefined> {
		const path = await this.fileDialogService.pickFileToSave(await this.suggestFileName(), options?.availableFileSystems);
		if (path) {
			this.telemetryService.publicLog2('searchEditor/saveSearchResults');
			if (await this.textFileService.saveAs(this.resource, path, options)) {
				this.setDirty(false);
				if (!isEqual(path, this.resource)) {
					const input = this.instantiationService.invokeFunction(getOrMakeSearchEditorInput, { uri: path, config: { ...this.query } });
					input.setHighlights(this.highlights);
					return input;
				}
				return this;
			}
		}
		return undefined;
	}

	getTypeId(): string {
		return SearchEditorInput.ID;
	}

	getName(maxLength = 12): string {
		const trimToMax = (label: string) => (label.length < maxLength ? label : `${label.slice(0, maxLength - 3)}...`);

		if (this.isUntitled()) {
			const query = this.query?.query?.trim();
			if (query) {
				return localize('searchTitle.withQuery', "Search: {0}", trimToMax(query));
			}
			return localize('searchTitle', "Search");
		}

		return localize('searchTitle.withQuery', "Search: {0}", basename(this.resource.path, '.code-search'));
	}

	async reloadModel() {
		const model = await this.model;
		this.query = model.searchConfig;
		this._highlights = model.resultsTextModel.getAllDecorations();

		this._onDidChangeLabel.fire();
		return model;
	}

	async setConfig(config: Partial<SearchConfiguration>) {
		(await this.model).setConfig(config);
	}

	getConfigSync() {
		return this.query;
	}

	async resolve() {
		return null;
	}

	async setDirty(dirty: boolean) {
		this.dirty = dirty;
		this._onDidChangeDirty.fire();

		await this.model;

		// fire again because some listeners dont attach early enough. See #89406 and #89267.
		this._onDidChangeDirty.fire();
	}

	isDirty() {
		return this.dirty;
	}

	isSaving(): boolean {
		if (!this.isDirty()) {
			return false; // the editor needs to be dirty for being saved
		}

		if (this.isUntitled()) {
			return false; // untitled are not saving automatically
		}

		if (this.filesConfigurationService.getAutoSaveMode() === AutoSaveMode.AFTER_SHORT_DELAY) {
			return true; // a short auto save is configured, treat this as being saved
		}

		return false;
	}

	isReadonly() {
		return false;
	}

	isUntitled() {
		return this.resource.scheme === SearchEditorScheme;
	}

	dispose() {
		this.modelService.destroyModel(this.resource);
		super.dispose();
	}

	matches(other: unknown) {
		if (this === other) { return true; }

		if (other instanceof SearchEditorInput) {
			if (
				(other.resource.path && other.resource.path === this.resource.path) ||
				(other.resource.fragment && other.resource.fragment === this.resource.fragment)
			) {
				return true;
			}
		}
		return false;
	}

	public get highlights(): IModelDeltaDecoration[] {
		return (this._highlights ?? []).map(({ range, options }) => ({ range, options }));
	}

	public async setHighlights(value: IModelDeltaDecoration[]) {
		if (!value) { return; }
		const model = await this.model;
		model.resultsTextModel.deltaDecorations([], value);
		this._highlights = value;
	}

	async revert(group: GroupIdentifier, options?: IRevertOptions) {
		// TODO: this should actually revert the contents. But it needs to set dirty false.
		super.revert(group, options);
		this.setDirty(false);
		return true;
	}

	private async backup(): Promise<IWorkingCopyBackup> {
		const content = (await this.model).createSnapshot();
		return { content };
	}

	// Bringing this over from textFileService because it only suggests for untitled scheme.
	// In the future I may just use the untitled scheme. I dont get particular benefit from using search-editor...
	private async suggestFileName(): Promise<URI> {
		const query = (await this.reloadModel()).searchConfig.query;

		const searchFileName = (query.replace(/[^\w \-_]+/g, '_') || 'Search') + '.code-search';

		const remoteAuthority = this.environmentService.configuration.remoteAuthority;
		const schemeFilter = remoteAuthority ? network.Schemas.vscodeRemote : network.Schemas.file;

		const defaultFilePath = this.fileDialogService.defaultFilePath(schemeFilter);
		if (defaultFilePath) {
			return joinPath(defaultFilePath, searchFileName);
		}

		return toLocalResource(URI.from({ scheme: schemeFilter, path: searchFileName }), remoteAuthority);
	}
}

const inputs = new Map<string, SearchEditorInput>();
export const getOrMakeSearchEditorInput = (
	accessor: ServicesAccessor,
	existingData:
		{ uri: URI, config?: Partial<SearchConfiguration>, text?: never } |
		{ text: string, uri?: never, config?: never } |
		{ config: Partial<SearchConfiguration>, text?: never, uri?: never }
): SearchEditorInput => {

	const uri = existingData.uri ?? URI.from({ scheme: SearchEditorScheme, fragment: `${Math.random()}` });

	const instantiationService = accessor.get(IInstantiationService);
	const modelService = accessor.get(IModelService);
	const textFileService = accessor.get(ITextFileService);
	const backupService = accessor.get(IBackupFileService);

	const existing = inputs.get(uri.toString());
	if (existing) {
		return existing;
	}

	const config = existingData.config ?? (existingData.text ? extractSearchQuery(existingData.text) : {});

	const getModel = async () => {

		const existing = modelService.getModel(uri);
		if (existing) {
			return instantiationService.createInstance(SearchEditorModel, { resultsTextModel: existing, searchConfig: config }, uri);
		}

		const backup = await backupService.resolve(uri);
		backupService.discardBackup(uri);

		let contents: string | ITextBufferFactory;

		if (backup) {
			contents = backup.value;
		} else if (uri.scheme !== SearchEditorScheme) {
			contents = (await textFileService.read(uri)).value;
		} else if (existingData.text) {
			contents = existingData.text;
		} else if (existingData.config) {
			contents = serializeSearchConfiguration(existingData.config);
		} else {
			throw new Error('no initial contents for search editor');
		}

		return instantiationService.createInstance(SearchEditorModel, { rawTextModel: contents }, uri);
	};

	const input = instantiationService.createInstance(SearchEditorInput, uri, getModel, config);

	inputs.set(uri.toString(), input);
	input.onDispose(() => inputs.delete(uri.toString()));

	return input;
};
