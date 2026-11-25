function createProjectPreviews(host) {
  function generatedPreview(item, spec) {
    const { isGeneratedImage, fs, path, previewResources } = host;
    if (!isGeneratedImage(item.savedPath)) return null;
    try {
      const folder = fs.realpathSync.native(path.dirname(item.savedPath));
      const project = { id: spec.projectId, path: folder, kind: 'local', previewRoot: folder, previewSingleFile: true, previewProjectPath: spec.cwd };
      return { images: [previewResources.open(project, path.basename(item.savedPath), 'image', undefined, true).url] };
    } catch { return null; }
  }
  async function projectImageCandidates(folder, candidates = 6, theme = 'mono') {
    const { listProjectImageCandidates, thumbnailProjectImage, PROJECT_IMAGE_LIMITS, projectSvgForTheme } = host;
    const result = await listProjectImageCandidates(folder, thumbnailProjectImage, { ...PROJECT_IMAGE_LIMITS, candidates });
    return { ...result, candidates: result.candidates.map(candidate => ({ ...candidate, image: projectSvgForTheme(candidate.image, theme) })) };
  }

  return { generatedPreview, projectImageCandidates };
}

function autoProjectImages(host) {
  const { createProjectImageAuto, store, projectImageCandidates, broadcast } = host;
  return createProjectImageAuto({
    getProject: id => host.quitting ? null : store.projects.find(project => project.id === id),
    listCandidates: folder => projectImageCandidates(folder, 1),
    setProjectImage: (id, image, mode) => store.setProjectImage(id, image, mode), broadcast,
  });
}

module.exports = { createProjectPreviews, autoProjectImages };
