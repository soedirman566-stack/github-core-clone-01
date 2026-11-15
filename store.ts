// store.ts — the forge's in-memory state.
//
// One Store holds every repository the viewer owns. A repository record keeps
// three planes side by side so all four surfaces read the same truth:
//   - the git plane: content-addressed objects and mutable refs;
//   - the collaboration plane: labels, issues, comments and pull requests,
//     with issues and pull requests sharing one numbering sequence;
//   - the metadata plane: name, description, visibility, default branch.
// Nothing is persisted; a trial starts from an empty forge.

import { VIEWER } from './scenario.ts';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface LabelRec {
  readonly name: string;
  readonly color: string;
}

export interface IssueRec {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly seq: number;
}

export interface CommentRec {
  readonly id: number;
  readonly issueNumber: number;
  readonly body: string;
}

export interface PullRec {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  /** The head tip when the pull request was opened (its head may move or vanish later). */
  readonly headShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly seq: number;
}

export interface RepoRec {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Bumped whenever refs move; part of the fetch-pack cache key. */
  gitVersion: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, LabelRec>;
  readonly issues: Map<number, IssueRec>;
  readonly pulls: Map<number, PullRec>;
  readonly comments: Map<number, CommentRec[]>;
  /** The next issue/pull number: one shared sequence per repository. */
  nextNumber: number;
  /** Cached fetch packs, keyed by request shape; values are immutable bytes. */
  readonly packCache: Map<string, Buffer>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  readonly viewer = VIEWER;
  private readonly reposByName = new Map<string, RepoRec>();
  private readonly reposById = new Map<number, RepoRec>();
  private nextRepoId = 1;
  private nextCommentId = 1;
  private seq = 0;

  createRepo(name: string, options: { description?: string; isPrivate?: boolean }): RepoRec | null {
    if (this.reposByName.has(name)) return null;
    const stamp = nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner: this.viewer.login,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      createdAt: stamp,
      updatedAt: stamp,
      gitVersion: 0,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      packCache: new Map(),
    };
    this.nextRepoId += 1;
    this.reposByName.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  /** A repository by owner/name; any owner but the viewer's is a miss, never a leak. */
  repo(owner: string, name: string): RepoRec | null {
    if (owner !== this.viewer.login) return null;
    return this.reposByName.get(name) ?? null;
  }

  repoById(id: number): RepoRec | null {
    return this.reposById.get(id) ?? null;
  }

  deleteRepo(repo: RepoRec): void {
    this.reposByName.delete(repo.name);
    this.reposById.delete(repo.id);
  }

  listRepos(): RepoRec[] {
    return [...this.reposByName.values()].sort((a, b) => a.id - b.id);
  }

  addIssue(repo: RepoRec, input: { title: string; body: string; labels?: string[] }): IssueRec {
    const issue: IssueRec = {
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...(input.labels ?? [])],
      seq: this.seq,
    };
    this.seq += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addPull(repo: RepoRec, input: { title: string; body: string; headRef: string; baseRef: string; headSha: string }): PullRec {
    const pull: PullRec = {
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      headRef: input.headRef,
      baseRef: input.baseRef,
      headShaAtCreate: input.headSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.seq,
    };
    this.seq += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  addComment(repo: RepoRec, issueNumber: number, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId, issueNumber, body };
    this.nextCommentId += 1;
    const list = repo.comments.get(issueNumber);
    if (list) list.push(comment);
    else repo.comments.set(issueNumber, [comment]);
    return comment;
  }

  commentsOf(repo: RepoRec, issueNumber: number): CommentRec[] {
    return repo.comments.get(issueNumber) ?? [];
  }
}
