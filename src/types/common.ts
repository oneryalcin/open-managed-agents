export interface ManagedAgentsListPage<T> {
  data: T[];
  has_more: boolean;
  next_page: string | null;
}
