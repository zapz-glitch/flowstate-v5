import React, { useEffect, useState } from 'react'
export default function dynamic(load, { loading: Loading }) {
  return function Dynamic(props) {
    const [Component, setComponent] = useState(null)
    useEffect(() => { let active = true; load().then(module => { if (active) setComponent(() => module.default) }); return () => { active = false } }, [])
    return Component ? <Component {...props} /> : <Loading />
  }
}
