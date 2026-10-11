import type { Lead, UnansweredQuestion } from '@sitebot/shared';
import { request, seg } from './api';

export async function listUnanswered(siteId: string, signal?: AbortSignal): Promise<UnansweredQuestion[]> {
  const res = await request<{ questions: UnansweredQuestion[] }>(`/api/sites/${seg(siteId)}/unanswered`, { signal });
  return res.questions;
}

export async function listLeads(siteId: string, signal?: AbortSignal): Promise<Lead[]> {
  const res = await request<{ leads: Lead[] }>(`/api/sites/${seg(siteId)}/leads`, { signal });
  return res.leads;
}
