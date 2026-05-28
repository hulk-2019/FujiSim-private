import type { StateCreator } from "zustand";
import { api } from "../../api";
import type { AppState, ProjectSlice } from "../types";

export const createProjectSlice: StateCreator<AppState, [], [], ProjectSlice> = (set, get) => ({
  projects: [],
  projectSummaries: [],
  trashedProjects: [],

  refreshProjects: async () => {
    const list = await api.listProjects().catch(() => []);
    set({ projects: list });
  },

  refreshProjectSummaries: async () => {
    const list = await api.getProjectSummaries().catch(() => []);
    set({ projectSummaries: list });
  },

  refreshTrash: async () => {
    const list = await api.listTrashProjects().catch(() => []);
    set({ trashedProjects: list });
  },

  restoreProject: async (id) => {
    await api.restoreProject(id);
    await Promise.all([get().refreshProjects(), get().refreshProjectSummaries(), get().refreshTrash()]);
  },

  purgeProject: async (id) => {
    await api.purgeProject(id);
    await get().refreshTrash();
  },

  purgeAllTrashProjects: async () => {
    await api.purgeAllTrashProjects();
    await get().refreshTrash();
  },
});
