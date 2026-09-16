import { Title } from '@solidjs/meta';
import { Loading } from 'solid-js';
import { Router } from './router';
import './App.css';

export default function App() {
  return (
    <Router>
      {(props) => (
        <>
          <Title>Tuner</Title>
          <Loading fallback={<main class="text-neutral-100">Loading…</main>}>
            {props.children}
          </Loading>
        </>
      )}
    </Router>
  );
}
