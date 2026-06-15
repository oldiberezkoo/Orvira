import type { BranchId } from "../db/schema.js";

export type Department = "kitchen" | "bar" | "hookah" | "service";

export const BRANCH_CONFIG: Record<
  BranchId,
  { label: string; departments: Department[] }
> = {
  myata_lounge: {
    label: "Myata Lounge",
    departments: ["kitchen", "bar", "hookah", "service"],
  },
  myata_signature_tashcity: {
    label: "Myata Signature TashkentCity",
    departments: ["kitchen", "bar", "hookah", "service"],
  },
  myata_signature_sky: {
    label: "Myata Signature Sky",
    departments: ["kitchen", "bar", "hookah", "service"],
  },
  gaogao: {
    label: "GaoGao",
    departments: ["kitchen", "bar", "service", "hookah"],
  },
  gao_coffee_tea: {
    label: "Gao Coffe&Tea",
    departments: ["bar", "service"],
  },
};

export const DEPARTMENT_LABELS: Record<Department, string> = {
  kitchen: "Кухня",
  bar: "Бар",
  hookah: "Кальян",
  service: "Сервис",
};

export function getDepartmentsForBranch(branch: BranchId): Department[] {
  return BRANCH_CONFIG[branch].departments;
}

export function hasDepartment(branch: BranchId, dept: Department): boolean {
  return BRANCH_CONFIG[branch].departments.includes(dept);
}
