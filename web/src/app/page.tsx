'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Database,
  Globe,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  TriangleAlert,
  Workflow,
} from 'lucide-react';

import { Account, api, Health, Job, Stats } from '@/lib/onboard-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

/* ------------------------------------------------------------------ misc */

function statusBadge(s: string) {
  const map: Record<string, string> = {
    provisioned: 'default',
    created: 'secondary',
    failed: 'destructive',
    dead: 'destructive',
    done: 'default',
    running: 'secondary',
    queued: 'outline',
    cancelled: 'outline',
  };
  return <Badge variant={map[s] ?? 'outline'}>{s}</Badge>;
}

function tsOf(iso: string | null): string {
  if (!iso) return '–';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

/* ------------------------------------------------------------------ page */

export default function Home() {
  const { toast } = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('accounts');
  // connectivity: consecutive poll failures + last good data timestamp
  const failCount = useRef(0);
  const [lastOk, setLastOk] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  // signup form
  const [country, setCountry] = useState('us');
  const [attempts, setAttempts] = useState('5');
  const [runTail, setRunTail] = useState(true);
  const [workspaces, setWorkspaces] = useState('1');

  // batch form
  const [batchCount, setBatchCount] = useState('2');
  const [batchCountries, setBatchCountries] = useState('us,de');
  const [cooldown, setCooldown] = useState('45');

  // chat
  const [chatAccount, setChatAccount] = useState<string>('');
  const [prompt, setPrompt] = useState('What is 2+2? Answer with just the number.');
  const [model, setModel] = useState<string>('default');
  const [effort, setEffort] = useState<string>('default');
  const [chatReply, setChatReply] = useState<{ reply: string; model: string | null } | null>(null);
  const [chatPending, setChatPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [h, s, a, j] = await Promise.all([
        api.health(),
        api.stats(),
        api.accounts(),
        api.jobs(),
      ]);
      setHealth(h);
      setStats(s);
      setAccounts(a);
      setJobs(j);
      failCount.current = 0;
      setDisconnected(false);
      setLastOk(new Date().toLocaleTimeString());
    } catch {
      // transient errors keep the last state, but 3+ in a row surface it
      failCount.current += 1;
      if (failCount.current >= 3) setDisconnected(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const activeJob = jobs.find((j) => j.status === 'running' || j.status === 'queued');

  async function launch(fn: () => Promise<{ job_id: number }>, what: string) {
    setBusy(true);
    try {
      const { job_id } = await fn();
      toast({ title: `${what} started`, description: `job #${job_id}` });
      setTab('jobs');
      refresh();
    } catch (e) {
      toast({
        title: `${what} failed`,
        description: String(e),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(id: number, email: string) {
    if (!confirm(`Delete account ${email}? All records will be removed.`)) return;
    try {
      await api.deleteAccount(id);
      toast({ title: 'Account deleted', description: email });
      refresh();
    } catch (e) {
      toast({ title: 'Delete failed', description: String(e), variant: 'destructive' });
    }
  }

  async function exportSession(id: number) {
    try {
      const r = await api.exportSession(id);
      toast({
        title: r.created ? 'Session created' : 'Session already exists',
        description: r.has_token ? r.session_path : 'WARNING: no token stored',
      });
    } catch (e) {
      toast({ title: 'Export failed', description: String(e), variant: 'destructive' });
    }
  }

  async function sendChat() {
    if (!chatAccount || !prompt.trim() || chatPending) return;
    setChatPending(true);
    setChatReply(null);
    try {
      const { job_id } = await api.chat(Number(chatAccount), {
        prompt,
        ...(model !== 'default' ? { model } : {}),
        ...(effort !== 'default' ? { effort } : {}),
      });
      toast({ title: 'Chat started', description: `job #${job_id}` });
      let consecutiveErrors = 0;
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const j = await api.job(job_id);
          consecutiveErrors = 0;
          if (j.status === 'done') {
            const item = (j.items ?? []).find((it) => it.label === 'chat');
            const d = (item?.detail ?? {}) as { reply?: string; model?: string };
            setChatReply({ reply: d.reply ?? '(empty reply)', model: d.model ?? null });
            refresh();
            break;
          }
          if (j.status === 'failed' || j.status === 'cancelled') {
            toast({
              title: 'Chat failed',
              description: j.error ?? 'see jobs',
              variant: 'destructive',
            });
            break;
          }
        } catch {
          consecutiveErrors += 1;
          if (consecutiveErrors >= 3) throw new Error('polling failed 3× in a row');
        }
        if (i === 119) {
          toast({
            title: `Job #${job_id} still running`,
            description: 'Check the Jobs tab for its progress.',
          });
        }
      }
    } catch (e) {
      toast({ title: 'Chat failed', description: String(e), variant: 'destructive' });
    } finally {
      setChatPending(false);
    }
  }

  const depsOk = health?.deps?.ok;
  const neverLoaded = health === null && !disconnected;

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ------------------------------------------------------- header */}
      <header className="border-b px-4 py-3 sm:px-6 flex flex-wrap items-center gap-3">
        <Workflow className="h-6 w-6 text-primary" />
        <div className="mr-auto">
          <h1 className="text-lg font-semibold leading-tight">Onboard Automation</h1>
          <p className="text-xs text-muted-foreground">
            Notion accounts — warm-session signup, provision, chat · API :3001
          </p>
        </div>
        {disconnected ? (
          <Badge variant="destructive" className="gap-1">
            <TriangleAlert className="h-3 w-3" />
            API unreachable{lastOk ? ` — data as of ${lastOk}` : ''}
          </Badge>
        ) : depsOk !== undefined ? (
          <Badge variant={depsOk ? 'default' : 'destructive'} className="gap-1">
            <Server className="h-3 w-3" />
            {depsOk ? 'backend healthy' : 'backend degraded'}
          </Badge>
        ) : null}
        {activeJob && (
          <Badge variant="secondary" className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            job #{activeJob.id} {activeJob.status}
          </Badge>
        )}
        <Button variant="ghost" size="icon" onClick={refresh} aria-label="refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </header>

      {/* --------------------------------------------------------- stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 px-4 sm:px-6 py-3">
        {[
          { icon: Database, label: 'accounts', value: stats?.accounts },
          { icon: Activity, label: 'provisioned', value: stats?.provisioned },
          { icon: Layers, label: 'workspaces', value: stats?.workspaces },
          { icon: Globe, label: 'trialing', value: stats?.trialing },
          { icon: Bot, label: 'api keys', value: stats?.api_keys },
          { icon: Plus, label: 'chats', value: stats?.chats },
          { icon: Plus, label: 'jobs', value: stats?.jobs },
          { icon: Globe, label: 'signup IPs', value: stats?.distinct_signup_ips },
        ].map((s) => (
          <Card key={s.label} className="p-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <s.icon className="h-4 w-4" />
              <span className="text-xs">{s.label}</span>
            </div>
            <div className="text-2xl font-bold tabular-nums">
              {neverLoaded ? (
                <span className="text-muted-foreground">…</span>
              ) : (
                (s.value ?? <span className="text-muted-foreground">–</span>)
              )}
            </div>
          </Card>
        ))}
      </div>

      {/* ---------------------------------------------------------- main */}
      <main className="flex-1 px-4 sm:px-6 pb-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4 flex-wrap h-auto">
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="signup">Sign up / Batch</TabsTrigger>
            <TabsTrigger value="jobs">Jobs</TabsTrigger>
            <TabsTrigger value="chat">Chat</TabsTrigger>
          </TabsList>

          {/* -------------------------------------------- accounts tab */}
          <TabsContent value="accounts">
            <Card>
              <CardHeader>
                <CardTitle>Accounts</CardTitle>
                <CardDescription>
                  Each row is a Notion identity: signup IP + region stored for
                  replay and hygiene (SKILL.md §9.5).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-[60vh] overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>email</TableHead>
                        <TableHead>status</TableHead>
                        <TableHead>signup IP</TableHead>
                        <TableHead>geo</TableHead>
                        <TableHead>ws / keys / chats</TableHead>
                        <TableHead>created</TableHead>
                        <TableHead className="text-right">actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {neverLoaded && (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                            Loading…
                          </TableCell>
                        </TableRow>
                      )}
                      {!neverLoaded && accounts.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                            No accounts yet — create one in “Sign up / Batch”.
                          </TableCell>
                        </TableRow>
                      )}
                      {accounts.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell className="font-mono">{a.id}</TableCell>
                          <TableCell className="font-mono text-xs max-w-[22rem] truncate" title={a.email}>
                            {a.email}
                          </TableCell>
                          <TableCell>{statusBadge(a.status)}</TableCell>
                          <TableCell className="font-mono text-xs">{a.signup_ip ?? '–'}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{a.proxy_country ?? '?'}</Badge>
                          </TableCell>
                          <TableCell className="tabular-nums text-xs">
                            {a.workspaces_n} / {a.keys_n} / {a.chats_n}
                          </TableCell>
                          <TableCell className="text-xs">{tsOf(a.created_at)}</TableCell>
                          <TableCell className="text-right whitespace-nowrap">
                            <Button
                              size="sm" variant="outline" className="mr-1"
                              disabled={busy || !!activeJob}
                              onClick={() =>
                                launch(() => api.tail(a.id, { workspaces: 1 }), `tail for ${a.email}`)
                              }
                            >
                              provision
                            </Button>
                            <Button
                              size="sm" variant="outline" className="mr-1"
                              onClick={() => exportSession(a.id)}
                            >
                              export
                            </Button>
                            <Button
                              size="sm" variant="ghost" aria-label="delete"
                              disabled={!!activeJob}
                              onClick={() => removeAccount(a.id, a.email)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------------------------------------- signup tab */}
          <TabsContent value="signup">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Single signup</CardTitle>
                  <CardDescription>
                    One warm Zenrows Browser Session: session-pinned residential
                    IP across the whole auth flow, then the full provisioning
                    tail (workspace → trial → key → chat).
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="country">proxy country</Label>
                      <Select value={country} onValueChange={setCountry}>
                        <SelectTrigger id="country"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {['us', 'de', 'gb', 'fr', 'ca', 'jp', 'au', 'br'].map((c) => (
                            <SelectItem key={c} value={c}>{c}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="attempts">attempts</Label>
                      <Input id="attempts" type="number" min={1} max={10}
                        value={attempts} onChange={(e) => setAttempts(e.target.value)} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch id="runTail" checked={runTail} onCheckedChange={setRunTail} />
                    <Label htmlFor="runTail">run provisioning tail after signup</Label>
                  </div>
                  {runTail && (
                    <div className="space-y-2">
                      <Label htmlFor="workspaces">workspaces per account</Label>
                      <Input id="workspaces" type="number" min={1} max={5}
                        value={workspaces} onChange={(e) => setWorkspaces(e.target.value)} />
                    </div>
                  )}
                  <Button
                    disabled={busy || !!activeJob}
                    onClick={() =>
                      launch(
                        () =>
                          api.signup({
                            country,
                            attempts: Number(attempts),
                            run_tail: runTail,
                            tail: { workspaces: Number(workspaces) },
                          }),
                        'Signup',
                      )
                    }
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
                    Create account
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Batch mode</CardTitle>
                  <CardDescription>
                    Sequential accounts with cooldown (rate-limit hygiene).
                    Countries rotate per account; failures are isolated.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="batchCount">count</Label>
                      <Input id="batchCount" type="number" min={1} max={10}
                        value={batchCount} onChange={(e) => setBatchCount(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="cooldown">cooldown (s)</Label>
                      <Input id="cooldown" type="number" min={0} max={3600}
                        value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="batchCountries">countries (comma-separated)</Label>
                    <Input id="batchCountries" value={batchCountries}
                      onChange={(e) => setBatchCountries(e.target.value)} />
                  </div>
                  <Button
                    disabled={busy || !!activeJob}
                    onClick={() =>
                      launch(
                        () =>
                          api.batch({
                            count: Number(batchCount),
                            countries: batchCountries.split(',').map((s) => s.trim()).filter(Boolean),
                            cooldown_seconds: Number(cooldown),
                          }),
                        'Batch',
                      )
                    }
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Run batch
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* ------------------------------------------------ jobs tab */}
          <TabsContent value="jobs">
            <Card>
              <CardHeader className="flex flex-row items-center">
                <div>
                  <CardTitle>Jobs</CardTitle>
                  <CardDescription>Live queue — auto-refreshes every 3s.</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {jobs.length === 0 && !neverLoaded && (
                  <p className="text-muted-foreground text-sm py-6 text-center">No jobs yet.</p>
                )}
                <div className="max-h-[60vh] overflow-auto space-y-2 pr-1">
                  {jobs.map((j) => (
                    <JobRow key={j.id} job={j} onChanged={refresh} />
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ------------------------------------------------ chat tab */}
          <TabsContent value="chat">
            <Card>
              <CardHeader>
                <CardTitle>Chat on a provisioned account</CardTitle>
                <CardDescription>
                  runInferenceTranscript via the backend — model selection,
                  effort, context pages, follow-up threads.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="chatAccount">account</Label>
                    <Select value={chatAccount} onValueChange={setChatAccount}>
                      <SelectTrigger id="chatAccount">
                        <SelectValue placeholder="select account" />
                      </SelectTrigger>
                      <SelectContent>
                        {accounts.map((a) => (
                          <SelectItem key={a.id} value={String(a.id)}>
                            #{a.id} {a.email.slice(0, 28)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <ModelSelect value={model} onChange={setModel} />
                  <EffortSelect value={effort} onChange={setEffort} model={model} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="prompt">prompt</Label>
                  <Input id="prompt" maxLength={4000} value={prompt}
                    onChange={(e) => setPrompt(e.target.value)} />
                </div>
                <Button onClick={sendChat} disabled={!chatAccount || !prompt.trim() || chatPending}>
                  {chatPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Bot className="h-4 w-4 mr-2" />
                  )}
                  {chatPending ? 'Waiting for reply…' : 'Send'}
                </Button>
                <Separator />
                {chatReply ? (
                  <div className="rounded-lg border bg-muted/40 p-4">
                    <div className="text-xs text-muted-foreground mb-1">
                      model: {chatReply.model ?? 'default'}
                    </div>
                    <div className="whitespace-pre-wrap">{chatReply.reply}</div>
                  </div>
                ) : chatPending ? (
                  <p className="text-sm text-muted-foreground">
                    Chat job queued — the runner is sequential, so it may wait
                    behind running jobs…
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Replies appear here (also stored per account in the DB).
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* ------------------------------------------------------- footer */}
      <footer className="border-t px-4 sm:px-6 py-3 mt-auto text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
        <span>onboard-automation backend v{health?.version ?? '?'}</span>
        <span>db: {health?.db ?? '–'}</span>
        <span>driver: {health?.service ?? '–'}</span>
        <span className="sm:ml-auto">
          signup route: Zenrows Browser Session (L4 · SKILL.md §9)
        </span>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------- subviews */

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [models, setModels] = useState<{ codename: string; name: string }[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.models().then(setModels).catch(() => setFailed(true));
  }, []);
  return (
    <div className="space-y-2">
      <Label htmlFor="chatModel">model</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="chatModel"><SelectValue placeholder="default (opal-quince)" /></SelectTrigger>
        <SelectContent className="max-h-72">
          <SelectItem value="default">default</SelectItem>
          {models.map((m) => (
            <SelectItem key={m.codename} value={m.codename}>
              {m.name} · {m.codename}
            </SelectItem>
          ))}
          {models.length === 0 && failed && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              model list unavailable
            </div>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

function EffortSelect({ value, onChange, model }: {
  value: string;
  onChange: (v: string) => void;
  model: string;
}) {
  const [all, setAll] = useState<{ codename: string; efforts: string[] }[]>([]);
  useEffect(() => {
    let alive = true;
    api.models()
      .then((ms) => {
        if (alive) setAll(ms.map((m) => ({ codename: m.codename, efforts: m.efforts })));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const efforts = all.find((m) => m.codename === model)?.efforts ?? [];
  const choices = efforts.length ? ['default', ...efforts] : ['default', 'low', 'medium', 'high'];
  return (
    <div className="space-y-2">
      <Label htmlFor="chatEffort">reasoning effort</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="chatEffort"><SelectValue placeholder="model default" /></SelectTrigger>
        <SelectContent>
          {choices.map((e) => (
            <SelectItem key={e} value={e}>{e}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function JobRow({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Job['items']>([]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () =>
      api
        .job(job.id)
        .then((j) => alive && setItems(j.items ?? []))
        .catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open, job.id]);

  const active = job.status === 'running' || job.status === 'queued';

  return (
    <div className="rounded-lg border">
      <div className="w-full flex items-center gap-3 px-3 py-2 text-left text-sm">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 h-auto p-0 justify-start font-normal gap-3"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="font-mono text-xs text-muted-foreground">#{job.id}</span>
          <span className="font-medium">{job.type}</span>
          {statusBadge(job.status)}
          {active && <Loader2 className="h-3 w-3 animate-spin" />}
          <span className="ml-auto text-xs text-muted-foreground">{tsOf(job.created_at)}</span>
        </Button>
        {active && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive text-xs underline h-auto py-0"
            onClick={async () => {
              await api.cancelJob(job.id).catch(() => {});
              onChanged();
            }}
          >
            cancel
          </Button>
        )}
      </div>
      {job.error && (
        <div className="px-3 pb-2 text-xs text-destructive">{job.error}</div>
      )}
      {open && (
        <div className="border-t px-3 py-2 space-y-1">
          {(items ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">no items</p>
          )}
          {(items ?? []).map((it) => (
            <div key={it.id} className="text-xs flex gap-2 items-start">
              <Badge variant="outline" className="text-[10px] shrink-0">
                {it.status}
              </Badge>
              <span className="font-mono">{it.label}</span>
              <span className="text-muted-foreground truncate max-w-[36rem]">
                {summarizeItem(it)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function summarizeItem(it: NonNullable<Job['items']>[number]): string {
  const d = it.detail ?? {};
  const step = d.step as { label?: string; result?: unknown } | undefined;
  if (step) {
    const r = JSON.stringify(step.result ?? {});
    return `${step.label}: ${r.slice(0, 120)}`;
  }
  const keys = ['email', 'ip', 'country', 'seconds', 'reply', 'model', 'steps', 'error'];
  const parts = keys.filter((k) => d[k] !== undefined).map((k) => `${k}=${String(d[k]).slice(0, 60)}`);
  if (parts.length) return parts.join(' · ');
  return JSON.stringify(d).slice(0, 120);
}
