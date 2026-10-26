import { useState } from 'react';
import type { Project } from '../../shared/types';
import { t } from '../../shared/i18n';
import { ProjectImageDialog } from '../workspace/ProjectImageDialog';
import './project-images-settings.css';

export function ProjectImagesSettings({ projects }: { projects: Project[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = projects.find(project => project.id === editingId);
  return <div className="project-images-settings">
    <p className="settings-note">{t('自动从项目图标、README 和素材中选择一次并固定；也可手动更改或恢复编号。')}</p>
    {projects.length === 0 && <p className="settings-note">{t('当前没有打开的项目。')}</p>}
    {projects.map((project, index) => {
      const mode = project.imageMode || (project.image ? 'custom' : 'auto');
      const location = project.kind === 'ssh' ? `${project.ssh?.host || ''}:${project.path}` : project.path;
      return <div key={project.id} className="setting-row project-image-setting-row" data-project-image-id={project.id}>
        <span><span className="project-image-setting-thumb" aria-hidden="true" data-audit-ignore>{project.image ? <img src={project.image} alt="" draggable={false} /> : String(index + 1).padStart(2, '0')}</span>
          <span className="project-image-setting-label"><b title={project.name}>{project.name}</b><small title={location}>{location}</small><small className="project-image-setting-mode">{t(mode === 'auto' ? '自动' : mode === 'custom' ? '自选' : '编号')}</small></span>
        </span>
        <button type="button" className="button secondary project-image-setting-change" aria-label={t('更改 {name} 的项目图片', { name: project.name })} onClick={() => setEditingId(project.id)}>{t('更改…')}</button>
      </div>;
    })}
    {editing && <ProjectImageDialog key={editing.id} project={editing} index={projects.indexOf(editing)} onClose={() => setEditingId(null)} />}
  </div>;
}
