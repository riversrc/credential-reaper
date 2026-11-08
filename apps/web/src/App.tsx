import { Route, Routes } from 'react-router-dom';
import { Layout, LandingLayout } from './components/Layout';
import { Landing } from './pages/Landing';
import { TheGrid } from './pages/TheGrid';
import { IdentityDetails } from './pages/IdentityDetails';
import { Investigations } from './pages/Investigations';
import { TheAfterlife } from './pages/TheAfterlife';
import { Activity } from './pages/Activity';
import { Remediation } from './pages/Remediation';

export function App() {
  return (
    <Routes>
      <Route element={<LandingLayout />}>
        <Route index element={<Landing />} />
      </Route>
      <Route element={<Layout />}>
        <Route path="grid" element={<TheGrid />} />
        <Route path="identities/:id" element={<IdentityDetails />} />
        <Route path="investigations" element={<Investigations />} />
        <Route path="afterlife" element={<TheAfterlife />} />
        <Route path="activity" element={<Activity />} />
        <Route path="remediation" element={<Remediation />} />
      </Route>
    </Routes>
  );
}

export default App;
