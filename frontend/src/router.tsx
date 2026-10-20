/**
 * Route tree (docs/07 "Screens"). Single-user local app: no login route, the app opens
 * on the singers library. Screens read params with `getRouteApi(<id>)`, so they never
 * import this file (no import cycles).
 */
import {
  createRootRoute, createRoute, createRouter, redirect, type RouterHistory,
} from '@tanstack/react-router';
import { Shell } from '@/app/Shell';
import { NotFound } from '@/app/NotFound';
import { SingersScreen } from '@/features/singers/SingersScreen';
import { SingerLayout } from '@/features/singers/SingerLayout';
import { SongsScreen } from '@/features/songs/SongsScreen';
import { DatasetScreen } from '@/features/dataset/DatasetScreen';
import { TrainingScreen } from '@/features/training/TrainingScreen';
import { VoiceScreen } from '@/features/voice/VoiceScreen';
import { LiveRunScreen } from '@/features/run/LiveRunScreen';
import { NewCoverScreen } from '@/features/covers/NewCoverScreen';
import { CoverScreen } from '@/features/covers/CoverScreen';
import { CoversScreen } from '@/features/covers/CoversScreen';
import { AnalysesScreen } from '@/features/analyses/AnalysesScreen';
import { AnalysisScreen } from '@/features/analyses/AnalysisScreen';
import { NewAnalysisScreen } from '@/features/analyses/NewAnalysisScreen';
import { QueueScreen } from '@/features/queue/QueueScreen';
import { SystemScreen } from '@/features/system/SystemScreen';

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const singersRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: SingersScreen });

const singerRoute = createRoute({ getParentRoute: () => rootRoute, path: '/singers/$id', component: SingerLayout });
const singerIndexRoute = createRoute({
  getParentRoute: () => singerRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/singers/$id/songs', params: { id: params.id } });
  },
});
const songsRoute = createRoute({ getParentRoute: () => singerRoute, path: 'songs', component: SongsScreen });
const datasetRoute = createRoute({ getParentRoute: () => singerRoute, path: 'dataset', component: DatasetScreen });
const trainingRoute = createRoute({ getParentRoute: () => singerRoute, path: 'training', component: TrainingScreen });
const voiceRoute = createRoute({ getParentRoute: () => singerRoute, path: 'voice', component: VoiceScreen });

const jobRoute = createRoute({ getParentRoute: () => rootRoute, path: '/jobs/$jobId', component: LiveRunScreen });

const coversRoute = createRoute({ getParentRoute: () => rootRoute, path: '/covers', component: CoversScreen });
const newCoverRoute = createRoute({ getParentRoute: () => rootRoute, path: '/covers/new', component: NewCoverScreen });
const coverRoute = createRoute({ getParentRoute: () => rootRoute, path: '/covers/$id', component: CoverScreen });

const analysesRoute = createRoute({ getParentRoute: () => rootRoute, path: '/analyses', component: AnalysesScreen });
const newAnalysisRoute = createRoute({ getParentRoute: () => rootRoute, path: '/analyses/new', component: NewAnalysisScreen });
const analysisRoute = createRoute({ getParentRoute: () => rootRoute, path: '/analyses/$id', component: AnalysisScreen });

const queueRoute = createRoute({ getParentRoute: () => rootRoute, path: '/queue', component: QueueScreen });
const systemRoute = createRoute({ getParentRoute: () => rootRoute, path: '/system', component: SystemScreen });

export const routeTree = rootRoute.addChildren([
  singersRoute,
  singerRoute.addChildren([singerIndexRoute, songsRoute, datasetRoute, trainingRoute, voiceRoute]),
  jobRoute,
  coversRoute,
  newCoverRoute,
  coverRoute,
  analysesRoute,
  newAnalysisRoute,
  analysisRoute,
  queueRoute,
  systemRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    ...(history ? { history } : {}),
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
